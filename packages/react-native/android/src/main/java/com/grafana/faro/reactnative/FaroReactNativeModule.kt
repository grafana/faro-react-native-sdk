package com.grafana.faro.reactnative

import android.os.Build
import android.os.Process
import android.os.SystemClock
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Faro React Native native module for performance monitoring
 *
 * Provides methods for monitoring:
 * - App startup time
 * - Memory usage (VmRSS)
 * - CPU usage (via CPUInfo helper)
 *
 * Uses Android OS APIs to get accurate metrics without requiring
 * manual initialization or timestamp capture.
 *
 * Implementation ported from Faro Flutter SDK:
 * https://github.com/grafana/faro-flutter-sdk/blob/main/android/src/main/java/com/grafana/faro/FaroPlugin.java
 *
 * TODO: Currently not tested in demo app due to Yarn workspace gradle path resolution issues.
 * See demo-react-native/android/settings.gradle for details. This code is complete and ready
 * to work in standalone React Native projects or once workspace gradle config is fixed.
 */
class FaroReactNativeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "FaroReactNativeModule"
    }

    private var anrTracker: ANRTracker? = null

    override fun getName(): String = NAME

    /**
     * Gets app startup duration in milliseconds using Android OS APIs
     *
     * Uses Process.getStartElapsedRealtime() which returns when the process
     * started, so no manual initialization is needed in MainActivity.
     *
     * Returns duration from process start to current time in milliseconds.
     * Returns 0 if Android version < N (API 24).
     *
     * @return Duration in milliseconds, or 0 if unsupported Android version
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getAppStartDuration(): Double {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val duration = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()
            return duration.toDouble()
        }
        return 0.0
    }

    /**
     * Gets current memory usage in kilobytes
     *
     * Reads VmRSS (Virtual Memory Resident Set Size) from /proc/[pid]/status.
     * This represents the actual physical memory currently used by the process.
     *
     * @return Memory usage in KB, or null on error
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getMemoryUsage(): Double? {
        return MemoryInfo.getMemoryUsage()
    }

    /**
     * Gets current CPU usage percentage
     *
     * Uses differential calculation - first call returns 0.0 (baseline),
     * subsequent calls return CPU usage percentage (0-100+).
     * Requires Android API 21+ (Lollipop).
     *
     * @return CPU usage percentage, or null on error or unsupported Android version
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getCpuUsage(): Double? {
        return CPUInfo.getCpuInfo()
    }

    /**
     * Start frame monitoring with configuration
     *
     * @param config Configuration map with targetFps, frozenFrameThresholdMs, normalizedRefreshRate
     */
    @ReactMethod
    fun startFrameMonitoring(config: ReadableMap) {
        val targetFps = if (config.hasKey("targetFps")) config.getDouble("targetFps") else 60.0
        val frozenFrameThresholdMs = if (config.hasKey("frozenFrameThresholdMs")) config.getDouble("frozenFrameThresholdMs") else 100.0
        val normalizedRefreshRate = if (config.hasKey("normalizedRefreshRate")) config.getDouble("normalizedRefreshRate") else 60.0

        FrameMonitor.configure(
            targetFps = targetFps,
            frozenFrameThresholdMs = frozenFrameThresholdMs,
            normalizedRefreshRate = normalizedRefreshRate
        )

        // Set up event callbacks to emit events to JavaScript
        FrameMonitor.setCallbacks(
            onSlowFrames = { count -> sendEvent("onSlowFrames", count) },
            onFrozenFrame = { count -> sendEvent("onFrozenFrame", count) },
            onRefreshRate = { rate -> sendEvent("onRefreshRate", rate) }
        )

        FrameMonitor.start()
    }

    /**
     * Stop frame monitoring
     */
    @ReactMethod
    fun stopFrameMonitoring() {
        FrameMonitor.stop()
    }

    /**
     * Get current refresh rate
     *
     * @param promise Promise to resolve with the refresh rate
     */
    @ReactMethod
    fun getRefreshRate(promise: Promise) {
        val refreshRate = FrameMonitor.getRefreshRate()
        if (refreshRate > 0) {
            promise.resolve(refreshRate)
        } else {
            promise.resolve(null)
        }
    }

    /**
     * Get frame metrics (refresh rate, slow frames, frozen frames)
     *
     * @param promise Promise to resolve with the metrics map
     */
    @ReactMethod
    fun getFrameMetrics(promise: Promise) {
        val metrics = WritableNativeMap().apply {
            putDouble("refreshRate", FrameMonitor.getRefreshRate())
            putInt("slowFrames", FrameMonitor.getAndResetSlowFrames())
            putInt("frozenFrames", FrameMonitor.getAndResetFrozenFrames())
        }
        promise.resolve(metrics)
    }

    /**
     * Start ANR (Application Not Responding) tracking
     *
     * @param config Configuration map with timeout (default 5000ms)
     */
    @ReactMethod
    fun startANRTracking(config: ReadableMap) {
        // Stop existing tracker if running
        anrTracker?.stopTracking()
        
        // Configure timeout
        val timeout = if (config.hasKey("timeout")) config.getDouble("timeout").toLong() else 5000L
        ANRTracker.timeout = timeout
        
        // Start new tracker
        anrTracker = ANRTracker()
        anrTracker?.start()
    }

    /**
     * Stop ANR tracking
     */
    @ReactMethod
    fun stopANRTracking() {
        anrTracker?.stopTracking()
        anrTracker = null
    }

    /**
     * Get ANR status (list of detected ANRs)
     *
     * @param promise Promise to resolve with the ANR list
     */
    @ReactMethod
    fun getANRStatus(promise: Promise) {
        val anrList = ANRTracker.getANRStatus()
        ANRTracker.resetANR()
        
        if (anrList != null) {
            val writableArray = com.facebook.react.bridge.Arguments.createArray()
            for (anr in anrList) {
                writableArray.pushString(anr)
            }
            promise.resolve(writableArray)
        } else {
            promise.resolve(null)
        }
    }

    /**
     * Get crash reports from previous app sessions
     *
     * Uses Android's ApplicationExitInfo API (Android 11+) to retrieve
     * crash and ANR information from previous sessions.
     *
     * @param promise Promise to resolve with the crash reports list
     */
    @ReactMethod
    fun getCrashReport(promise: Promise) {
        val crashReports = FaroCrashReporter.getCrashReports(reactApplicationContext)
        
        if (crashReports != null) {
            val writableArray = com.facebook.react.bridge.Arguments.createArray()
            for (report in crashReports) {
                writableArray.pushString(report)
            }
            promise.resolve(writableArray)
        } else {
            promise.resolve(null)
        }
    }

    /**
     * Persist the current Faro session ID to native storage.
     *
     * Called only when a new session starts.
     * Enables crash reports to include the session ID where the crash occurred,
     * allowing users to correlate crashes with pre-crash events in Grafana.
     *
     * @param sessionId The current Faro session ID
     */
    @ReactMethod
    fun persistSessionId(sessionId: String) {
        FaroCrashReporter.persistSessionId(reactApplicationContext, sessionId)
    }

    /**
     * Send an event to JavaScript
     */
    private fun sendEvent(eventName: String, data: Any) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, data)
        } catch (_: Exception) {
            // Ignore errors when sending events
        }
    }
}
