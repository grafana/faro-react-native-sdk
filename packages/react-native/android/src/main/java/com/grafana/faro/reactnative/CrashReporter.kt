package com.grafana.faro.reactnative

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

/**
 * Crash reporter implementation using Android's ApplicationExitInfo API.
 *
 * Implementation ported from Faro Flutter SDK's ExitInfoHelper.java.
 *
 * Uses ApplicationExitInfo (Android 11+) to retrieve crash and ANR information
 * from previous app sessions.
 */
object CrashReporter {
    private const val TAG = "CrashReporter"
    private const val PREFS_NAME = "faro_crash_reporter"
    private const val HANDLED_EXIT_INFOS_KEY = "handled_exit_infos"
    private const val MAX_EXIT_REASONS = 15
    private const val MAX_TRACE_BYTES = 1024 * 1024 // 1MB max for trace data

    /**
     * Exit reasons that should be captured and reported.
     */
    @RequiresApi(Build.VERSION_CODES.R)
    private val EXIT_REASONS_TO_CAPTURE = listOf(
        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_LOW_MEMORY,
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE
    )

    /**
     * Get crash reports from previous app sessions.
     *
     * @param context Application context
     * @return List of crash report JSON strings, or null if none found
     */
    fun getCrashReports(context: Context): List<String>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.d(TAG, "ApplicationExitInfo requires API level 30 (Android 11) or higher")
            return null
        }

        return getCrashReportsImpl(context)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun getCrashReportsImpl(context: Context): List<String>? {
        try {
            val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            if (activityManager == null) {
                Log.e(TAG, "ActivityManager is null")
                return null
            }

            val exitInfoList = activityManager.getHistoricalProcessExitReasons(null, 0, MAX_EXIT_REASONS)
            if (exitInfoList.isNullOrEmpty()) {
                Log.d(TAG, "No exit information available")
                return null
            }

            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val handledExitInfos = getHandledExitInfos(prefs)
            val newExitInfo = mutableListOf<ApplicationExitInfo>()
            val updatedHandledExitInfos = handledExitInfos.toMutableSet()

            for (exitInfo in exitInfoList) {
                val exitInfoKey = getUniqueId(exitInfo)
                if (!handledExitInfos.contains(exitInfoKey) && shouldBeReported(exitInfo)) {
                    newExitInfo.add(exitInfo)
                    updatedHandledExitInfos.add(exitInfoKey)
                }
            }

            setHandledExitInfos(prefs, updatedHandledExitInfos)

            if (newExitInfo.isEmpty()) {
                return null
            }

            val crashReports = mutableListOf<String>()
            for (exitInfo in newExitInfo) {
                val jsonObject = getExitInfoJson(exitInfo)
                if (jsonObject != null) {
                    crashReports.add(jsonObject.toString())
                }
            }

            return if (crashReports.isEmpty()) null else crashReports
        } catch (e: Exception) {
            Log.e(TAG, "Error getting crash reports", e)
            return null
        }
    }

    /**
     * Clear processed crash reports.
     */
    fun clearCrashReports(context: Context) {
        // The reports are already marked as handled when retrieved
        // This method is provided for API consistency with Flutter
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun shouldBeReported(exitInfo: ApplicationExitInfo): Boolean {
        try {
            val reason = exitInfo.reason
            if (!EXIT_REASONS_TO_CAPTURE.contains(reason)) {
                return false
            }

            // Filter out normal system terminations of background apps
            val isBackgroundNormalExit = exitInfo.status == 0 && exitInfo.importance > 300
            if (isBackgroundNormalExit) {
                return reason != ApplicationExitInfo.REASON_LOW_MEMORY &&
                        reason != ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE
            }

            return true
        } catch (e: Exception) {
            Log.e(TAG, "Error checking if exit info should be reported", e)
            return false
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun getUniqueId(exitInfo: ApplicationExitInfo): String {
        return "${exitInfo.timestamp}_${exitInfo.pid}"
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun getExitInfoJson(exitInfo: ApplicationExitInfo): JSONObject? {
        try {
            val jsonObject = JSONObject()

            jsonObject.put("type", getReasonName(exitInfo))
            jsonObject.put("timestamp", exitInfo.timestamp)
            jsonObject.put("timestamp_readable_utc", java.util.Date(exitInfo.timestamp).toString())
            jsonObject.put("status", exitInfo.status)
            jsonObject.put("description", exitInfo.description ?: "")
            jsonObject.put("importance", exitInfo.importance)
            jsonObject.put("pid", exitInfo.pid)
            jsonObject.put("processName", exitInfo.processName ?: "")

            // Add trace data for crashes if available
            val reason = exitInfo.reason
            if ((reason == ApplicationExitInfo.REASON_CRASH ||
                        reason == ApplicationExitInfo.REASON_CRASH_NATIVE ||
                        reason == ApplicationExitInfo.REASON_ANR)) {
                val trace = readTraceInputStream(exitInfo)
                if (!trace.isNullOrEmpty()) {
                    jsonObject.put("stacktrace", trace)
                }
            }

            return jsonObject
        } catch (e: Exception) {
            Log.e(TAG, "Error creating exit info JSON", e)
            return null
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun getReasonName(exitInfo: ApplicationExitInfo): String {
        return when (exitInfo.reason) {
            ApplicationExitInfo.REASON_ANR -> "ANR"
            ApplicationExitInfo.REASON_CRASH -> "CRASH"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
            ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
            ApplicationExitInfo.REASON_OTHER -> "OTHER"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
            ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
            ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
            else -> "UNKNOWN_${exitInfo.reason}"
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun readTraceInputStream(exitInfo: ApplicationExitInfo): String? {
        try {
            val inputStream = exitInfo.traceInputStream ?: return null

            val result = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            var totalBytesRead = 0
            var bytesRead: Int

            while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                result.write(buffer, 0, bytesRead)
                totalBytesRead += bytesRead

                if (totalBytesRead > MAX_TRACE_BYTES) {
                    Log.w(TAG, "Trace data too large, truncating")
                    break
                }
            }

            inputStream.close()
            return result.toString(StandardCharsets.UTF_8.name())
        } catch (e: Exception) {
            Log.e(TAG, "Error reading trace data", e)
            return null
        }
    }

    private fun getHandledExitInfos(prefs: SharedPreferences): Set<String> {
        return prefs.getStringSet(HANDLED_EXIT_INFOS_KEY, emptySet()) ?: emptySet()
    }

    private fun setHandledExitInfos(prefs: SharedPreferences, exitInfos: Set<String>) {
        prefs.edit().putStringSet(HANDLED_EXIT_INFOS_KEY, exitInfos).apply()
    }
}
