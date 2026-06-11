package com.grafana.faro.reactnative

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Reports ANRs from ApplicationExitInfo (Android 11+), Sentry AnrV2 style.
 *
 * Kept separate from [FaroCrashReporter] so ANR timeout rows are not replayed as
 * generic previous-session `crash` events (no message / duplicate rows).
 */
object FaroAnrReporter {

    private const val PREFS_NAME = "com.grafana.faro.anr_reporter"
    private const val KEY_LAST_PROCESSED_TIMESTAMP = "last_processed_anr_timestamp"

    @JvmStatic
    fun getAnrReports(context: Context): List<String>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return null

        val exitInfoList = activityManager.getHistoricalProcessExitReasons(
            context.packageName,
            0,
            10,
        )

        if (exitInfoList.isEmpty()) {
            return null
        }

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastProcessedTimestamp = prefs.getLong(KEY_LAST_PROCESSED_TIMESTAMP, 0)

        val reports = mutableListOf<String>()
        var latestTimestamp = lastProcessedTimestamp

        val anrExits = exitInfoList
            .filter { it.timestamp > lastProcessedTimestamp && it.reason == ApplicationExitInfo.REASON_ANR }
            .groupBy { it.timestamp }
            .mapValues { (_, exits) -> pickBestAnrExit(exits) }
            .toSortedMap()

        for ((timestamp, exitInfo) in anrExits) {
            if (exitInfo.timestamp > latestTimestamp) {
                latestTimestamp = exitInfo.timestamp
            }

            val json = exportAnrAsJSON(context, exitInfo) ?: continue
            reports.add(json)
        }

        if (latestTimestamp > lastProcessedTimestamp) {
            prefs.edit()
                .putLong(KEY_LAST_PROCESSED_TIMESTAMP, latestTimestamp)
                .apply()
        }

        return if (reports.isEmpty()) null else reports
    }

    private fun pickBestAnrExit(exits: List<ApplicationExitInfo>): ApplicationExitInfo {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return exits.first()
        }

        return exits.maxByOrNull { exit ->
            var score = 0
            if (getTraceInfo(exit).isNotEmpty()) {
                score += 2
            }
            val description = exit.description?.trim().orEmpty()
            if (description.isNotEmpty()) {
                score += 1
            }
            score
        } ?: exits.first()
    }

    private fun exportAnrAsJSON(context: Context, exitInfo: ApplicationExitInfo): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }

        val fullTrace = getTraceInfo(exitInfo)
        if (fullTrace.isEmpty()) {
            // Align with Sentry: skip ANRs without an actionable trace stream.
            return null
        }

        val mainStack = AnrThreadDumpParser.extractMainThreadStack(fullTrace)
        if (mainStack.isEmpty() || AnrStackFilters.isCrashHandlerStack(mainStack)) {
            return null
        }

        val rawDescription = exitInfo.description?.trim().orEmpty()
        val description = rawDescription.ifEmpty { "Application Not Responding" }

        FaroAnrCache.recordDetectionTimestamp(context, exitInfo.timestamp)

        return JSONObject().apply {
            put("type", "ANR")
            put("timestamp", exitInfo.timestamp)
            put("duration", ANRTracker.timeout)
            put("stacktrace", mainStack)
            put("description", description)
            put("source", "AppExitInfo")
            put("processName", exitInfo.processName ?: "")
            put("pid", exitInfo.pid)
        }.toString()
    }

    private fun getTraceInfo(exitInfo: ApplicationExitInfo): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return ""
        }

        return try {
            val traceInputStream = exitInfo.traceInputStream ?: return ""
            val reader = BufferedReader(InputStreamReader(traceInputStream))
            val trace = StringBuilder()
            var lineCount = 0
            val maxLines = 500

            reader.useLines { lines ->
                for (line in lines) {
                    if (lineCount >= maxLines) break
                    trace.appendLine(line)
                    lineCount++
                }
            }

            trace.toString().trim()
        } catch (_: Exception) {
            ""
        }
    }
}

/**
 * Reject watchdog snapshots taken while the process is tearing down after a crash.
 * Uses only Android framework and Faro SDK frame names.
 */
internal object AnrStackFilters {
    fun isCrashHandlerStack(stack: String): Boolean {
        val normalized = stack.lowercase()
        return normalized.contains("handleapplicationcrash") ||
            normalized.contains("killapplicationhandler") ||
            normalized.contains("farouncaughtexceptionhandler")
    }
}
