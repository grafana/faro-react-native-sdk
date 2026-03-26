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
 * - REASON_ANR: Application Not Responding
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

        val crashReports = mutableListOf<String>()
        var latestTimestamp = lastProcessedTimestamp

        for (exitInfo in exitInfoList) {
            // Skip already processed entries
            if (exitInfo.timestamp <= lastProcessedTimestamp) {
                continue
            }

            // Only process crash-related exit reasons
            if (!isCrashReason(exitInfo.reason)) {
                continue
            }

            // Track the latest timestamp
            if (exitInfo.timestamp > latestTimestamp) {
                latestTimestamp = exitInfo.timestamp
            }

            // Convert to JSON
            val jsonString = exportExitInfoAsJSON(exitInfo)
            if (jsonString != null) {
                crashReports.add(jsonString)
            }
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
     * Check if the exit reason indicates a crash or ANR.
     */
    private fun isCrashReason(reason: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return false
        }

        return when (reason) {
            ApplicationExitInfo.REASON_CRASH,
            ApplicationExitInfo.REASON_CRASH_NATIVE,
            ApplicationExitInfo.REASON_ANR,
            ApplicationExitInfo.REASON_LOW_MEMORY,
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> true
            else -> false
        }
    }

    /**
     * Convert ApplicationExitInfo to JSON string matching iOS format.
     */
    private fun exportExitInfoAsJSON(exitInfo: ApplicationExitInfo): String? {
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
            json.put("description", exitInfo.description ?: getDefaultDescription(exitInfo.reason))

            // Process info
            json.put("processName", exitInfo.processName ?: "")
            json.put("pid", exitInfo.pid)

            // Importance (Android-specific)
            json.put("importance", exitInfo.importance)

            // Stack trace (if available)
            val trace = getTraceInfo(exitInfo)
            if (trace.isNotEmpty()) {
                json.put("trace", trace)
            }

            json.toString()
        } catch (e: Exception) {
            null
        }
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
