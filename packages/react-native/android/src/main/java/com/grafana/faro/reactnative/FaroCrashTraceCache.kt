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

    data class PendingTrace(val trace: String, val timestampMs: Long)

    /**
     * Returns a cached trace without clearing it so multiple ApplicationExitInfo
     * rows for the same crash can share the UncaughtExceptionHandler stack.
     */
    fun peekPendingCrashTrace(context: Context): PendingTrace? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val trace = prefs.getString(KEY_TRACE, null)?.trim().orEmpty()
        val cachedTimestamp = prefs.getLong(KEY_TIMESTAMP, 0L)

        if (trace.isEmpty() || cachedTimestamp == 0L) {
            return null
        }

        return PendingTrace(trace, cachedTimestamp)
    }

    fun traceForExitTimestamp(pending: PendingTrace?, exitTimestampMs: Long): String {
        if (pending == null) {
            return ""
        }
        val delta = kotlin.math.abs(exitTimestampMs - pending.timestampMs)
        return if (delta <= MAX_TIMESTAMP_DELTA_MS) pending.trace else ""
    }

    fun clearPendingCrashTrace(context: Context) {
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_TRACE)
            .remove(KEY_TIMESTAMP)
            .apply()
    }

    /**
     * @deprecated Prefer peek + clearPendingCrashTrace so one crash can backfill several exit rows.
     */
    fun consumePendingCrashTrace(context: Context, exitTimestampMs: Long): String? {
        val pending = peekPendingCrashTrace(context) ?: return null
        val trace = traceForExitTimestamp(pending, exitTimestampMs)
        if (trace.isEmpty()) {
            return null
        }
        clearPendingCrashTrace(context)
        return trace
    }
}
