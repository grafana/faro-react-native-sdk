package com.grafana.faro.reactnative

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Android Crash Reporter using ApplicationExitInfo API (Android 11+).
 *
 * This class handles:
 * 1. Retrieving crash reports from previous sessions via ApplicationExitInfo
 * 2. Converting crash data to JSON format compatible with Faro
 *
 * ## Architecture
 * Android's ApplicationExitInfo API (API 30+) provides information about how
 * the app exited in previous sessions. This includes crashes, ANRs, and other
 * termination reasons.
 *
 * ## Supported Exit Reasons
 * - REASON_CRASH: Java/Kotlin exception crash
 * - REASON_CRASH_NATIVE: Native (NDK) crash
 * - REASON_LOW_MEMORY: Killed due to low memory
 * - REASON_EXCESSIVE_RESOURCE_USAGE: Killed due to excessive resource usage
 *
 * ## Usage
 * This is called automatically by the CrashReportingInstrumentation in TypeScript.
 */
object FaroCrashReporter {

    private const val TAG = "FaroCrashReporter"
    private const val PREFS_NAME = "com.grafana.faro.crash_reporter"
    private const val KEY_LAST_PROCESSED_TIMESTAMP = "last_processed_timestamp"

    /**
     * Gets crash reports from previous sessions as JSON strings.
     *
     * Returns a list of JSON strings, each representing a crash report.
     * The JSON format matches the iOS implementation for consistency.
     * Only returns new crash reports since the last call.
     *
     * @param context Android context
     * @return List of crash report JSON strings, or null if no crashes or unsupported API
     */
    @JvmStatic
    fun getCrashReports(context: Context): List<String>? {
        FaroUncaughtExceptionHandler.install(context)
        // ApplicationExitInfo requires Android 11 (API 30)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return null

        val exitInfoList = activityManager.getHistoricalProcessExitReasons(
            context.packageName,
            0, // pid 0 = all processes
            10 // max number of entries
        )

        if (exitInfoList.isEmpty()) {
            return null
        }

        // Get the last processed timestamp to avoid duplicate reports
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastProcessedTimestamp = prefs.getLong(KEY_LAST_PROCESSED_TIMESTAMP, 0)

        val pendingTrace = FaroCrashTraceCache.peekPendingCrashTrace(context)
        var usedPendingTrace = false

        val crashReports = mutableListOf<String>()
        var latestTimestamp = lastProcessedTimestamp
        val reportedTimestamps = mutableSetOf<Long>()

        // Android can return multiple ApplicationExitInfo rows for one fatal exit
        // (e.g. REASON_CRASH plus a companion row with no trace). Collapse to one
        // report per timestamp and share the UncaughtExceptionHandler cache.
        val candidates = exitInfoList
            .filter { it.timestamp > lastProcessedTimestamp && isCrashReason(it.reason) }
            .groupBy { it.timestamp }
            .mapValues { (_, exits) -> pickBestExitInfo(exits) }
            .toSortedMap()

        for ((timestamp, exitInfo) in candidates) {
            if (reportedTimestamps.contains(timestamp)) {
                continue
            }

            if (exitInfo.timestamp > latestTimestamp) {
                latestTimestamp = exitInfo.timestamp
            }

            val jsonString = exportExitInfoAsJSON(context, exitInfo, pendingTrace) { consumed ->
                if (consumed) {
                    usedPendingTrace = true
                }
            }

            if (jsonString != null) {
                crashReports.add(jsonString)
                reportedTimestamps.add(timestamp)
            }
        }

        if (usedPendingTrace) {
            FaroCrashTraceCache.clearPendingCrashTrace(context)
        }

        // Update the last processed timestamp
        if (latestTimestamp > lastProcessedTimestamp) {
            prefs.edit()
                .putLong(KEY_LAST_PROCESSED_TIMESTAMP, latestTimestamp)
                .apply()
        }

        return if (crashReports.isEmpty()) null else crashReports
    }

    /**
     * Prefer the row that already carries a trace stream; otherwise keep the first entry.
     */
    private fun pickBestExitInfo(exits: List<ApplicationExitInfo>): ApplicationExitInfo {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return exits.first()
        }

        return exits.maxByOrNull { exit ->
            var score = 0
            if (exit.reason == ApplicationExitInfo.REASON_CRASH) {
                score += 4
            } else if (exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                score += 3
            }
            val trace = getTraceInfo(exit)
            if (trace.isNotEmpty()) {
                score += 2
            }
            if (hasExceptionHeader(trace)) {
                score += 2
            }
            val description = exit.description?.trim().orEmpty()
            if (description.isNotEmpty()) {
                score += 1
            }
            score
        } ?: exits.first()
    }

    /**
     * Check if the exit reason should be replayed as a previous-session crash.
     * ANRs are excluded: ANRInstrumentation reports them with the blocked main-thread stack.
     */
    private fun isCrashReason(reason: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return false
        }

        return when (reason) {
            ApplicationExitInfo.REASON_CRASH,
            ApplicationExitInfo.REASON_CRASH_NATIVE,
            ApplicationExitInfo.REASON_LOW_MEMORY,
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> true
            else -> false
        }
    }

    /**
     * Convert ApplicationExitInfo to JSON string matching iOS format.
     */
    private fun exportExitInfoAsJSON(
        context: Context,
        exitInfo: ApplicationExitInfo,
        pendingTrace: FaroCrashTraceCache.PendingTrace?,
        onPendingTraceUsed: (Boolean) -> Unit,
    ): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }

        return try {
            val json = JSONObject()

            // Reason - maps to crash type
            json.put("reason", getReasonString(exitInfo.reason))

            // Timestamp - Unix timestamp in milliseconds
            json.put("timestamp", exitInfo.timestamp)

            // Status - exit status code
            json.put("status", exitInfo.status)

            // Description - human-readable description
            val rawDescription = exitInfo.description?.trim().orEmpty()
            val description = rawDescription.takeIf { it.isNotEmpty() && !isGenericDescription(it) }
                ?: getDefaultDescription(exitInfo.reason)
            json.put("description", description)

            // Process info
            json.put("processName", exitInfo.processName ?: "")
            json.put("pid", exitInfo.pid)

            // Importance (Android-specific)
            json.put("importance", exitInfo.importance)

            // Stack trace from ApplicationExitInfo, or from UncaughtExceptionHandler cache
            // when traceInputStream is null (common on emulators / Android 16+).
            val exitTrace = getTraceInfo(exitInfo)
            val cachedTrace = FaroCrashTraceCache.traceForExitTimestamp(context, pendingTrace, exitInfo.timestamp)
            if (isAnrTimeoutDescription(rawDescription)) {
                // ANRInstrumentation reports these with type ANR.
                return null
            }

            if (FaroAnrCache.hasNearbyAnrDetection(context, exitInfo.timestamp)) {
                // Same incident already captured by ANRTracker + ANRInstrumentation.
                return null
            }

            val trace = resolveCrashTrace(exitTrace, cachedTrace)
            if (trace.isNotEmpty()) {
                if (exitTrace.isEmpty() && cachedTrace.isNotEmpty()) {
                    onPendingTraceUsed(true)
                } else if (cachedTrace.isNotEmpty() && trace == cachedTrace) {
                    onPendingTraceUsed(true)
                }
                json.put("trace", trace)
            } else if (!hasMeaningfulDescription(exitInfo)) {
                // Skip duplicate/no-signal rows that would surface as generic "crash" in the UI.
                return null
            }

            json.toString()
        } catch (e: Exception) {
            null
        }
    }

    /**
     * ApplicationExitInfo traces on emulators often contain only "at …" frame lines.
     * UncaughtExceptionHandler cache includes the exception class + message header
     * required for plugin titles (e.g. java.lang.NullPointerException).
     */
    private fun resolveCrashTrace(exitTrace: String, cachedTrace: String): String {
        val exit = exitTrace.trim()
        val cached = cachedTrace.trim()

        if (exit.isEmpty()) {
            return cached
        }
        if (cached.isEmpty()) {
            return exit
        }

        val exitHasHeader = hasExceptionHeader(exit)
        val cachedHasHeader = hasExceptionHeader(cached)

        return when {
            cachedHasHeader && !exitHasHeader -> cached
            exitHasHeader && !cachedHasHeader -> exit
            cached.length > exit.length -> cached
            else -> exit
        }
    }

    private fun isAnrTimeoutDescription(description: String): Boolean {
        val normalized = description.trim().lowercase()
        if (normalized.isEmpty()) {
            return false
        }
        return normalized.contains("input dispatching timed out") ||
            normalized.contains("not responding") ||
            normalized.contains("application not responding")
    }

    private fun hasExceptionHeader(trace: String): Boolean {
        return trace.lineSequence().any { line ->
            val trimmed = line.trim()
            trimmed.isNotEmpty() &&
                !trimmed.startsWith("at ") &&
                trimmed.contains('.') &&
                !trimmed.startsWith("Caused by:")
        }
    }

    private fun isGenericDescription(description: String): Boolean {
        val normalized = description.trim().lowercase()
        return normalized in setOf(
            "crash",
            "native crash",
            "application crash",
            "application crash (java/kotlin)",
            "application crash (native)",
        )
    }

    private fun hasMeaningfulDescription(exitInfo: ApplicationExitInfo): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return false
        }

        val description = exitInfo.description?.trim().orEmpty()
        if (description.isEmpty()) {
            return false
        }

        return !isGenericDescription(description)
    }

    /**
     * Get human-readable reason string from exit reason code.
     */
    private fun getReasonString(reason: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return "UNKNOWN"
        }

        return when (reason) {
            ApplicationExitInfo.REASON_CRASH -> "CRASH"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
            ApplicationExitInfo.REASON_ANR -> "ANR"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
            ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
            ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
            ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
            ApplicationExitInfo.REASON_OTHER -> "OTHER"
            else -> "UNKNOWN"
        }
    }

    /**
     * Get default description for exit reason.
     */
    private fun getDefaultDescription(reason: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return "Application crash"
        }

        return when (reason) {
            ApplicationExitInfo.REASON_CRASH -> "Application crash (Java/Kotlin)"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "Application crash (Native)"
            ApplicationExitInfo.REASON_ANR -> "Application Not Responding"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "Application terminated due to low memory"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Application terminated due to excessive resource usage"
            else -> "Application crash"
        }
    }

    /**
     * Get stack trace info from ApplicationExitInfo.
     */
    private fun getTraceInfo(exitInfo: ApplicationExitInfo): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return ""
        }

        return try {
            val traceInputStream = exitInfo.traceInputStream ?: return ""
            val reader = BufferedReader(InputStreamReader(traceInputStream))
            val trace = StringBuilder()
            var lineCount = 0
            val maxLines = 100 // Limit trace length

            reader.useLines { lines ->
                for (line in lines) {
                    if (lineCount >= maxLines) break
                    trace.appendLine(line)
                    lineCount++
                }
            }

            trace.toString().trim()
        } catch (e: Exception) {
            ""
        }
    }
}
