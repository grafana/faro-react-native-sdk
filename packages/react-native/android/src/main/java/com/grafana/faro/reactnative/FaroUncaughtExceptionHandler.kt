package com.grafana.faro.reactnative

import android.content.Context
import android.util.Log

/**
 * Captures Java/Kotlin stack traces for fatal crashes before the process exits.
 *
 * ApplicationExitInfo.traceInputStream is often null on emulators and some devices
 * (observed on Android 16 / API 36). Without this handler the SDK cannot report
 * native frames for retrace.
 */
internal class FaroUncaughtExceptionHandler(
    private val context: Context,
    private val originalHandler: Thread.UncaughtExceptionHandler?,
) : Thread.UncaughtExceptionHandler {

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
        try {
            val trace = Log.getStackTraceString(throwable).trim()
            if (trace.isNotEmpty()) {
                FaroCrashTraceCache.savePendingCrashTrace(context, trace, System.currentTimeMillis())
            }
        } catch (_: Throwable) {
            // Never interfere with the original crash path.
        } finally {
            originalHandler?.uncaughtException(thread, throwable)
                ?: run {
                    @Suppress("DEPRECATION")
                    android.os.Process.killProcess(android.os.Process.myPid())
                    System.exit(10)
                }
        }
    }

    companion object {
        @Volatile
        private var installed = false

        @JvmStatic
        fun install(context: Context) {
            if (installed) {
                return
            }
            synchronized(this) {
                if (installed) {
                    return
                }
                val appContext = context.applicationContext
                val current = Thread.getDefaultUncaughtExceptionHandler()
                if (current is FaroUncaughtExceptionHandler) {
                    installed = true
                    return
                }
                Thread.setDefaultUncaughtExceptionHandler(
                    FaroUncaughtExceptionHandler(appContext, current)
                )
                installed = true
            }
        }
    }
}
