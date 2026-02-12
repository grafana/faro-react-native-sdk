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
}
