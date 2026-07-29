package com.grafana.faro.reactnative

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject

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

    private data class ExitGroupKey(
        val timestampMs: Long,
        val pid: Int,
        val processName: String,
    )

    private sealed interface ExportResult {
        data class Report(val json: String) : ExportResult
        data object Ignored : ExportResult
        data object Failed : ExportResult
    }

    /**
     * Persists a text tombstone backtrace for the next [REASON_CRASH_NATIVE] replay.
     *
     * Use when [ApplicationExitInfo.getTraceInputStream] is null (common on emulators)
     * and the app can capture a native backtrace immediately before a fatal native exit.
     */
    @JvmStatic
    fun cachePendingNativeCrashTrace(context: Context, trace: String) {
        FaroNativeCrashTrace.cachePendingNativeCrashTrace(context, trace)
    }

    /**
     * Gets crash reports from previous sessions as JSON strings.
     *
     * Returns a list of JSON strings, each representing a crash report.
     * The JSON format matches the iOS implementation for consistency.
     * Retrieval is non-destructive. Reports remain pending until JavaScript
     * acknowledges successful delivery or an intentional local filter.
     *
     * @param context Android context
     * @return List of crash report JSON strings, or null if no crashes or unsupported API
     */
    @JvmOverloads
    @JvmStatic
    fun getCrashReports(
        context: Context,
        nowMs: Long = System.currentTimeMillis(),
    ): List<String>? {
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

        // Preserve the old watermark as a one-way migration boundary. New reports
        // use stable IDs and are acknowledged only after delivery.
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val legacyLastProcessedTimestamp = prefs.getLong(KEY_LAST_PROCESSED_TIMESTAMP, 0)

        val pendingTrace = FaroCrashTraceCache.peekPendingCrashTrace(context, nowMs)

        val crashReports = mutableListOf<String>()

        // Android can return multiple ApplicationExitInfo rows for one fatal exit
        // (e.g. REASON_CRASH plus a companion row with no trace). Collapse to one
        // report per process/timestamp and share the UncaughtExceptionHandler cache.
        val candidates = exitInfoList
            .filter {
                it.timestamp > legacyLastProcessedTimestamp &&
                    isCrashReason(it.reason)
            }
            .groupBy {
                ExitGroupKey(
                    timestampMs = it.timestamp,
                    pid = it.pid,
                    processName = it.processName.orEmpty(),
                )
            }
            .mapValues { (_, exits) -> pickBestExitInfo(exits) }
            .entries
            .sortedBy { it.key.timestampMs }

        for ((_, exitInfo) in candidates) {
            val reportId = FaroCrashIds.reportId(
                packageName = context.packageName,
                timestampMs = exitInfo.timestamp,
                pid = exitInfo.pid,
                processName = exitInfo.processName.orEmpty(),
            )
            if (FaroCrashSessionStore.isReportAcknowledged(context, reportId, nowMs)) {
                continue
            }
            if (!isWithinReplayWindow(exitInfo.timestamp, nowMs)) {
                FaroCrashSessionStore.acknowledgeReports(
                    context = context,
                    reportIds = listOf(reportId),
                    nowMs = nowMs,
                )
                continue
            }

            val sessionContext = FaroCrashSessionStore.contextForPendingReport(context, reportId, nowMs)
                ?: FaroCrashSessionStore.findMatchingContext(
                    context = context,
                    crashTimestampMs = exitInfo.timestamp,
                    pid = exitInfo.pid,
                    processName = exitInfo.processName.orEmpty(),
                    nowMs = nowMs,
                )
            var usedPendingTrace = false

            val exportResult = exportExitInfoAsJSON(
                context = context,
                exitInfo = exitInfo,
                reportId = reportId,
                sessionContext = sessionContext,
                pendingTrace = pendingTrace,
            ) { consumed ->
                if (consumed) {
                    usedPendingTrace = true
                }
            }

            when (exportResult) {
                is ExportResult.Report -> {
                    FaroCrashSessionStore.rememberPendingReport(
                        context = context,
                        reportId = reportId,
                        crashTimestampMs = exitInfo.timestamp,
                        sessionContext = sessionContext,
                        usesPendingTrace = usedPendingTrace,
                        nowMs = nowMs,
                    )
                    crashReports.add(exportResult.json)
                }
                ExportResult.Ignored -> {
                    // Prevent intentionally filtered companion or ANR rows from
                    // being reconsidered on every subsequent app launch.
                    FaroCrashSessionStore.acknowledgeReports(
                        context = context,
                        reportIds = listOf(reportId),
                        nowMs = nowMs,
                    )
                }
                ExportResult.Failed -> Unit
            }
        }

        return if (crashReports.isEmpty()) null else crashReports
    }

    @JvmStatic
    fun acknowledgeCrashReports(
        context: Context,
        reportIds: Collection<String>,
    ): Boolean {
        val result = FaroCrashSessionStore.acknowledgeReports(context, reportIds)
        if (!result.persisted) {
            return false
        }
        if (result.clearPendingTrace) {
            FaroCrashTraceCache.clearPendingCrashTrace(context)
        }
        return true
    }

    internal fun isWithinReplayWindow(
        crashTimestampMs: Long,
        nowMs: Long,
    ): Boolean {
        if (crashTimestampMs <= 0L || crashTimestampMs > nowMs) {
            return false
        }
        return nowMs - crashTimestampMs <= FaroCrashSessionStore.MAX_CONTEXT_AGE_MS
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
            val trace = readExitTrace(exit).text
            if (trace.isNotEmpty()) {
                score += 2
            }
            if (TombstoneBacktraceFormatter.looksLikeNativeBacktrace(trace)) {
                score += 3
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
        reportId: String,
        sessionContext: FaroCrashSessionStore.SessionContext?,
        pendingTrace: FaroCrashTraceCache.PendingTrace?,
        onPendingTraceUsed: (Boolean) -> Unit,
    ): ExportResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return ExportResult.Failed
        }

        return try {
            val json = JSONObject()

            json.put("reportId", reportId)

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

            if (sessionContext != null) {
                json.put("sessionId", sessionContext.sessionId)
                sessionContext.isSampled?.let { json.put("isSampled", it) }
                sessionContext.appVersion?.let { json.put("appVersion", it) }
                sessionContext.appRelease?.let { json.put("appRelease", it) }
                sessionContext.appBundleId?.let { json.put("appBundleId", it) }
            }

            if (isAnrTimeoutDescription(rawDescription)) {
                // ANRInstrumentation reports these with type ANR.
                return ExportResult.Ignored
            }

            val parsedExitTrace = readExitTrace(exitInfo)
            val cachedTrace = cachedTraceForExit(context, exitInfo, pendingTrace)
            val trace = resolveCrashTrace(
                exitTrace = parsedExitTrace.text,
                cachedTrace = cachedTrace,
                isNativeCrash = exitInfo.reason == ApplicationExitInfo.REASON_CRASH_NATIVE,
            )

            if (FaroAnrCache.hasNearbyAnrDetection(context, exitInfo.timestamp) &&
                trace.isEmpty() &&
                !hasMeaningfulDescription(exitInfo)
            ) {
                // Suppress empty generic crash rows that duplicate a nearby ANR report.
                // Real crashes with a trace still surface even when an ANR happened nearby.
                return ExportResult.Ignored
            }

            if (trace.isNotEmpty()) {
                if (parsedExitTrace.text.isEmpty() && cachedTrace.isNotEmpty()) {
                    onPendingTraceUsed(true)
                } else if (cachedTrace.isNotEmpty() && trace == cachedTrace) {
                    onPendingTraceUsed(true)
                }
                json.put("trace", trace)

                val signal = parsedExitTrace.signal.trim()
                if (signal.isNotEmpty()) {
                    json.put("signal", signal)
                }

                if (TombstoneBacktraceFormatter.looksLikeNativeBacktrace(trace)) {
                    val preview = trace.lineSequence().firstOrNull { it.contains("#00 pc") }?.trim().orEmpty()
                    Log.i(
                        TAG,
                        "[Faro crash native] Exporting crash report with tombstone trace (${trace.lineSequence().count()} lines) preview=$preview",
                    )
                }
            } else if (!hasMeaningfulDescription(exitInfo)) {
                // Skip duplicate/no-signal rows that would surface as generic "crash" in the UI.
                if (exitInfo.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                    Log.w(
                        TAG,
                        "[Faro crash native] Skipping CRASH_NATIVE without tombstone trace (traceInputStream was null and no cached native backtrace)",
                    )
                }
                return ExportResult.Ignored
            }

            ExportResult.Report(json.toString())
        } catch (_: Exception) {
            ExportResult.Failed
        }
    }

    private fun cachedTraceForExit(
        context: Context,
        exitInfo: ApplicationExitInfo,
        pendingTrace: FaroCrashTraceCache.PendingTrace?,
    ): String {
        val cached = FaroCrashTraceCache.traceForExitTimestamp(context, pendingTrace, exitInfo.timestamp)
        if (cached.isEmpty()) {
            return ""
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            exitInfo.reason == ApplicationExitInfo.REASON_CRASH_NATIVE
        ) {
            cached.takeIf { TombstoneBacktraceFormatter.looksLikeNativeBacktrace(it) }.orEmpty()
        } else {
            cached
        }
    }

    /**
     * ApplicationExitInfo traces on emulators often contain only "at …" frame lines.
     * UncaughtExceptionHandler cache includes the exception class + message header
     * required for plugin titles (e.g. java.lang.NullPointerException).
     */
    private fun resolveCrashTrace(
        exitTrace: String,
        cachedTrace: String,
        isNativeCrash: Boolean,
    ): String {
        val exit = exitTrace.trim()
        val cached = cachedTrace.trim()

        if (isNativeCrash) {
            if (TombstoneBacktraceFormatter.looksLikeNativeBacktrace(exit)) {
                return exit
            }
            if (TombstoneBacktraceFormatter.looksLikeNativeBacktrace(cached)) {
                return cached
            }
            return exit.ifEmpty { cached }
        }

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

    private fun readExitTrace(exitInfo: ApplicationExitInfo): ApplicationExitTraceReader.ParsedExitTrace {
        return ApplicationExitTraceReader.read(exitInfo)
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
                !trimmed.startsWith("#") &&
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
}
