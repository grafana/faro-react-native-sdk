package com.farorndemo

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Demo-only native module for testing crash reporting.
 *
 * This module is NOT part of the Faro SDK - it exists only in the demo app
 * to allow triggering test crashes and ANRs for demonstration purposes.
 *
 * WARNING: Do not include this in production apps!
 */
class CrashTestModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "CrashTestModule"
    }

    override fun getName(): String = NAME

    /**
     * Trigger a test crash (Java/Kotlin RuntimeException)
     *
     * This crashes on the Android main thread (UI thread), bypassing
     * React Native's error handler. This ensures the app actually terminates
     * and the crash is captured by ApplicationExitInfo.
     *
     * WARNING: This will immediately terminate the app!
     */
    @ReactMethod
    fun triggerTestCrash() {
        // Post to the main Android thread to bypass React Native's JS error handler
        Handler(Looper.getMainLooper()).post {
            throw RuntimeException("Faro Test Crash: This is an intentional crash for testing crash reporting")
        }
    }

    /**
     * Trigger an ANR by blocking the main thread
     *
     * This method blocks the main thread for 60 seconds, which should
     * trigger an ANR (Application Not Responding) and cause the system
     * to force-kill the app. This ensures the ANR is recorded as
     * REASON_ANR in ApplicationExitInfo (not REASON_CRASH).
     *
     * Note: Android's ANR watchdog typically kills apps after ~5-10 seconds
     * of unresponsiveness, so the system should kill the app automatically
     * before the 60 seconds completes.
     *
     * WARNING: This will freeze the app until the system kills it!
     */
    @ReactMethod
    fun triggerANR() {
        // Post to main Android thread to ensure we block the UI thread
        Handler(Looper.getMainLooper()).post {
            // Block main thread for 60 seconds - system should kill before this completes
            Thread.sleep(60000)
        }
    }

    /**
     * Trigger a freeze by blocking the main thread for a shorter duration
     *
     * This blocks the main thread for 3 seconds, causing frozen frames
     * to be detected by FrameMonitoringInstrumentation. Unlike triggerANR,
     * this completes before the system kills the app.
     *
     * WARNING: This will freeze the app for 3 seconds!
     */
    @ReactMethod
    fun triggerFreeze() {
        Handler(Looper.getMainLooper()).post {
            // Block for 3 seconds - long enough to cause frozen frames
            // but short enough to avoid triggering ANR
            Thread.sleep(3000)
        }
    }

    /**
     * Trigger slow frames by doing moderate CPU work on the main thread
     *
     * Creates janky animations by periodically blocking the main thread
     * for 20-30ms, causing frames to drop below 60 FPS.
     *
     * WARNING: This will cause janky UI for 5 seconds!
     */
    @ReactMethod
    fun triggerSlowFrames() {
        Handler(Looper.getMainLooper()).post {
            val startTime = System.currentTimeMillis()
            val duration = 5000L // 5 seconds
            var iteration = 0

            while (System.currentTimeMillis() - startTime < duration) {
                // Do CPU-intensive work that takes ~20-30ms
                var sum = 0.0
                for (i in 0..500_000) {
                    sum += i.toDouble()
                }

                // Small sleep to allow some frames to render (but slowly)
                Thread.sleep(20) // 20ms = ~50fps (slow but not frozen)

                iteration++

                // Every 20 iterations, give the UI a brief break
                if (iteration % 20 == 0) {
                    Thread.sleep(5) // 5ms break
                }
            }

            android.util.Log.d(NAME, "Slow frames simulation completed: $iteration iterations")
        }
    }

    /**
     * Trigger heavy load with mixed slow frames and occasional freezes
     *
     * Simulates a worst-case scenario with continuous poor performance.
     * Combines slow frame rendering with periodic freezes.
     *
     * WARNING: This will cause severe performance issues for 10 seconds!
     */
    @ReactMethod
    fun triggerHeavyLoad() {
        Handler(Looper.getMainLooper()).post {
            val startTime = System.currentTimeMillis()
            val duration = 10000L // 10 seconds
            var iteration = 0

            while (System.currentTimeMillis() - startTime < duration) {
                // Most iterations: slow frames (20-30ms work)
                var sum = 0.0
                for (i in 0..500_000) {
                    sum += i.toDouble()
                }
                Thread.sleep(20) // 20ms = slow frame

                iteration++

                // Every 10th iteration: brief freeze (150ms)
                if (iteration % 10 == 0) {
                    Thread.sleep(150) // 150ms = frozen frame
                    android.util.Log.d(NAME, "Heavy load: freeze #${iteration / 10}")
                }
            }

            android.util.Log.d(NAME, "Heavy load simulation completed: $iteration iterations")
        }
    }
}
