package com.grafana.faro.reactnative

import android.content.Context
import android.util.Log

/**
 * Public helpers for NDK crash reporting integrations.
 *
 * Apps can call [cachePendingNativeCrashTrace] immediately before an intentional native
 * crash when ApplicationExitInfo.traceInputStream is unavailable (common on emulators).
 * The cached tombstone text is attached on the next launch when the exit reason is
 * REASON_CRASH_NATIVE.
 */
object FaroNativeCrashTrace {

    private const val TAG = "FaroCrashReporter"

    /**
     * Persists a text tombstone backtrace for the next ApplicationExitInfo replay.
     *
     * The trace must contain native frame lines (`#00 pc … libfoo.so`) so the Faro
     * collector can run NDK retrace.
     */
    @JvmStatic
    fun cachePendingNativeCrashTrace(context: Context, trace: String) {
        val trimmed = trace.trim()
        if (trimmed.isEmpty()) {
            Log.w(TAG, "[Faro crash native] Ignoring empty pending native trace cache")
            return
        }
        if (!TombstoneBacktraceFormatter.looksLikeNativeBacktrace(trimmed)) {
            Log.w(TAG, "[Faro crash native] Ignoring pending native trace without #00 pc frames")
            return
        }

        FaroCrashTraceCache.savePendingCrashTrace(context, trimmed, System.currentTimeMillis())
        Log.i(TAG, "[Faro crash native] Cached pending native tombstone (${trimmed.lineSequence().count()} lines)")
    }
}
