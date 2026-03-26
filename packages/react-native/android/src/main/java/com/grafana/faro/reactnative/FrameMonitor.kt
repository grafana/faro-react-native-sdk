package com.grafana.faro.reactnative

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Frame monitoring implementation using Choreographer.
 *
 * Implementation ported from Faro Flutter SDK's FaroPlugin.java.
 *
 * Uses Choreographer.FrameCallback to measure actual frame durations
 * and detect slow/frozen frames.
 */
object FrameMonitor {
    private const val TAG = "FrameMonitor"
    private const val NANOSECONDS_IN_SECOND = 1_000_000_000L
    private const val NANOSECONDS_IN_MILLISECOND = 1_000_000L

    // Throttle refresh rate emits to avoid flooding the JS bridge (was ~60/sec).
    // Aligns with refreshRatePollingInterval (30s) on iOS and Flutter SDK.
    private const val REFRESH_RATE_EMIT_INTERVAL_MS = 30_000L

    // Configuration
    private var targetFps: Double = 60.0
    private var frozenFrameThresholdNs: Long = 100 * NANOSECONDS_IN_MILLISECOND
    private var normalizedRefreshRate: Double = 60.0

    // State
    private var lastFrameTimeNanos: Long = 0
    private var lastRefreshRate: Double = 0.0
    private var lastRefreshRateEmitTimeMs: Long = 0
    private val slowFrameEventCount = AtomicInteger(0)
    private val frozenFrameCount = AtomicInteger(0)
    private var frozenFrameDurationMs: Double = 0.0
    private val isMonitoring = AtomicBoolean(false)

    // Slow frame event detection
    private var inSlowFrameEvent: Boolean = false
    private var slowFrameEventStartTimeNanos: Long = 0
    // Minimum duration (in nanoseconds) for a slow frame event to be counted (~3 frames at 60fps)
    private val slowFrameEventMinDurationNs: Long = 50 * NANOSECONDS_IN_MILLISECOND

    // Callbacks
    private var frameCallback: Choreographer.FrameCallback? = null
    private var onSlowFrames: ((Int) -> Unit)? = null
    private var onFrozenFrame: ((Int, Double) -> Unit)? = null
    private var onRefreshRate: ((Double) -> Unit)? = null

    /**
     * Configure monitoring parameters.
     *
     * @param targetFps Target FPS for slow frame detection (default 60)
     * @param frozenFrameThresholdMs Threshold in ms for frozen frames (default 100)
     * @param normalizedRefreshRate Normalized rate for high-refresh displays (default 60)
     */
    fun configure(
        targetFps: Double = 60.0,
        frozenFrameThresholdMs: Double = 100.0,
        normalizedRefreshRate: Double = 60.0
    ) {
        this.targetFps = targetFps
        this.frozenFrameThresholdNs = (frozenFrameThresholdMs * NANOSECONDS_IN_MILLISECOND).toLong()
        this.normalizedRefreshRate = normalizedRefreshRate
    }

    /**
     * Set callbacks for frame events.
     */
    fun setCallbacks(
        onSlowFrames: ((Int) -> Unit)? = null,
        onFrozenFrame: ((Int, Double) -> Unit)? = null,
        onRefreshRate: ((Double) -> Unit)? = null
    ) {
        this.onSlowFrames = onSlowFrames
        this.onFrozenFrame = onFrozenFrame
        this.onRefreshRate = onRefreshRate
    }

    /**
     * Start frame monitoring.
     */
    fun start() {
        if (isMonitoring.get()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            isMonitoring.set(true)
            lastFrameTimeNanos = 0
            lastRefreshRateEmitTimeMs = 0
            slowFrameEventCount.set(0)
            frozenFrameCount.set(0)
            frozenFrameDurationMs = 0.0
            inSlowFrameEvent = false
            slowFrameEventStartTimeNanos = 0

            frameCallback = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    if (isMonitoring.get()) {
                        checkFrameDuration(frameTimeNanos)
                        Choreographer.getInstance().postFrameCallback(this)
                    }
                }
            }

            Handler(Looper.getMainLooper()).post {
                Choreographer.getInstance().postFrameCallback(frameCallback!!)
            }
        }
    }

    /**
     * Stop frame monitoring.
     */
    fun stop() {
        isMonitoring.set(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN && frameCallback != null) {
            Handler(Looper.getMainLooper()).post {
                try {
                    Choreographer.getInstance().removeFrameCallback(frameCallback!!)
                } catch (_: Exception) {
                    // Ignore errors during cleanup
                }
            }
            frameCallback = null
        }

        // Reset state
        lastFrameTimeNanos = 0
        slowFrameEventCount.set(0)
        frozenFrameCount.set(0)
        frozenFrameDurationMs = 0.0
    }

    /**
     * Get current refresh rate.
     */
    fun getRefreshRate(): Double {
        return lastRefreshRate
    }

    /**
     * Get and reset slow frame event count.
     */
    fun getAndResetSlowFrames(): Int {
        val count = slowFrameEventCount.getAndSet(0)
        return count
    }

    /**
     * Get and reset frozen frame count.
     */
    fun getAndResetFrozenFrames(): Int {
        return frozenFrameCount.getAndSet(0)
    }

    /**
     * Get and reset frozen frame duration in milliseconds.
     */
    @Synchronized
    fun getAndResetFrozenDuration(): Double {
        val duration = frozenFrameDurationMs
        frozenFrameDurationMs = 0.0
        return duration
    }

    /**
     * Check if monitoring is active.
     */
    fun isMonitoring(): Boolean {
        return isMonitoring.get()
    }

    private fun checkFrameDuration(frameTimeNanos: Long) {
        if (lastFrameTimeNanos == 0L) {
            lastFrameTimeNanos = frameTimeNanos
            return
        }

        val frameDuration = frameTimeNanos - lastFrameTimeNanos
        if (frameDuration <= 0) {
            lastFrameTimeNanos = frameTimeNanos
            return
        }

        // Calculate refresh rate
        val fps = NANOSECONDS_IN_SECOND.toDouble() / frameDuration
        lastRefreshRate = fps

        // Throttle: only emit refresh rate every 30 seconds to avoid flooding
        val nowMs = System.currentTimeMillis()
        val refreshRateCallback = onRefreshRate
        if (refreshRateCallback != null && nowMs - lastRefreshRateEmitTimeMs >= REFRESH_RATE_EMIT_INTERVAL_MS) {
            lastRefreshRateEmitTimeMs = nowMs
            refreshRateCallback.invoke(fps)
        }

        // Check for slow frames using event-based detection
        // A slow frame "event" is a period of consecutive frames below target FPS
        // This groups consecutive slow frames to report meaningful jank, not microsecond variations
        val isSlow = fps < targetFps
        if (isSlow) {
            android.util.Log.d(TAG, "[Faro DEBUG ANDROID] 🐌 Slow frame detected: %.1f FPS (target: %.1f)".format(fps, targetFps))
        }
        
        if (isSlow) {
            if (!inSlowFrameEvent) {
                // Start new slow frame event
                inSlowFrameEvent = true
                slowFrameEventStartTimeNanos = frameTimeNanos
            }
        } else {
            // Frame is good - check if we should end the current slow frame event
            if (inSlowFrameEvent) {
                val eventDurationNs = frameTimeNanos - slowFrameEventStartTimeNanos
                val eventDurationMs = eventDurationNs / NANOSECONDS_IN_MILLISECOND
                val thresholdMs = slowFrameEventMinDurationNs / NANOSECONDS_IN_MILLISECOND
                
                // Only count as a slow frame event if it lasted long enough to be user-perceptible
                // This filters out single-frame dips that don't affect user experience
                if (eventDurationNs >= slowFrameEventMinDurationNs) {
                    val newCount = slowFrameEventCount.incrementAndGet()
                    // 🔍 TEMP DEBUG LOG - Remove after analysis
                    android.util.Log.d(TAG, "[Faro DEBUG ANDROID] ✅ COUNTED as event (${eventDurationMs}ms)! Total events now: $newCount")
                } else {
                    // 🔍 TEMP DEBUG LOG - Remove after analysis
                    android.util.Log.d(TAG, "[Faro DEBUG ANDROID] ❌ NOT counted (${eventDurationMs}ms is too short). Total events still: ${slowFrameEventCount.get()}")
                }
                
                inSlowFrameEvent = false
                slowFrameEventStartTimeNanos = 0
            }
        }

        // Check for frozen frames (frame duration exceeds threshold)
        if (frameDuration > frozenFrameThresholdNs) {
            val count = frozenFrameCount.incrementAndGet()
            val durationMs = frameDuration.toDouble() / NANOSECONDS_IN_MILLISECOND
            
            // Track duration (synchronized to avoid race conditions)
            synchronized(this) {
                frozenFrameDurationMs += durationMs
            }
            
            onFrozenFrame?.invoke(count, durationMs)
        }

        lastFrameTimeNanos = frameTimeNanos
    }
}
