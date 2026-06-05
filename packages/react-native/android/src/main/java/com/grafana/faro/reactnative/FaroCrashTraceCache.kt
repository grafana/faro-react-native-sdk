package com.grafana.faro.reactnative

import android.content.Context

/**
 * Persists a pending native crash stack between process death and the next launch.
 */
internal object FaroCrashTraceCache {
    private const val PREFS_NAME = "com.grafana.faro.crash_trace_cache"
    private const val KEY_TRACE = "pending_trace"
    private const val KEY_TIMESTAMP = "pending_timestamp"
    private const val MAX_TIMESTAMP_DELTA_MS = 10_000L

    fun savePendingCrashTrace(context: Context, trace: String, timestampMs: Long) {
        // commit() not apply(): the process is killed immediately after uncaughtException.
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TRACE, trace)
            .putLong(KEY_TIMESTAMP, timestampMs)
            .commit()
    }

    /**
     * Returns a cached trace when ApplicationExitInfo has no trace stream but the
     * exit timestamp matches the cached crash (same session).
     */
    fun consumePendingCrashTrace(context: Context, exitTimestampMs: Long): String? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val trace = prefs.getString(KEY_TRACE, null)?.trim().orEmpty()
        val cachedTimestamp = prefs.getLong(KEY_TIMESTAMP, 0L)

        if (trace.isEmpty() || cachedTimestamp == 0L) {
            return null
        }

        val delta = kotlin.math.abs(exitTimestampMs - cachedTimestamp)
        if (delta > MAX_TIMESTAMP_DELTA_MS) {
            return null
        }

        prefs.edit()
            .remove(KEY_TRACE)
            .remove(KEY_TIMESTAMP)
            .apply()

        return trace
    }
}
