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
    private val slowFrameCount = AtomicInteger(0)
    private val frozenFrameCount = AtomicInteger(0)
    private val isMonitoring = AtomicBoolean(false)

    // Callbacks
    private var frameCallback: Choreographer.FrameCallback? = null
    private var onSlowFrames: ((Int) -> Unit)? = null
    private var onFrozenFrame: ((Int) -> Unit)? = null
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
        onFrozenFrame: ((Int) -> Unit)? = null,
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
            slowFrameCount.set(0)
            frozenFrameCount.set(0)

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
        slowFrameCount.set(0)
        frozenFrameCount.set(0)
    }

    /**
     * Get current refresh rate.
     */
    fun getRefreshRate(): Double {
        return lastRefreshRate
    }

    /**
     * Get and reset slow frame count.
     */
    fun getAndResetSlowFrames(): Int {
        return slowFrameCount.getAndSet(0)
    }

    /**
     * Get and reset frozen frame count.
     */
    fun getAndResetFrozenFrames(): Int {
        return frozenFrameCount.getAndSet(0)
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

        // Check for slow frames (below target FPS)
        if (fps < targetFps) {
            val count = slowFrameCount.incrementAndGet()
            onSlowFrames?.invoke(count)
        }

        // Check for frozen frames (frame duration exceeds threshold)
        if (frameDuration > frozenFrameThresholdNs) {
            val count = frozenFrameCount.incrementAndGet()
            onFrozenFrame?.invoke(count)
        }

        lastFrameTimeNanos = frameTimeNanos
    }
}
