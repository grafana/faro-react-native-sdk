package com.grafana.faro.reactnative

import android.os.Looper
import android.view.Choreographer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.util.ReflectionHelpers
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [23, 34])
@LooperMode(LooperMode.Mode.PAUSED)
class FrameMonitorTest {
    @Before
    fun setUp() {
        ShadowChoreographer.setPaused(true)
    }

    @After
    fun tearDown() {
        FrameMonitor.stop()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun stopBeforeQueuedStartDoesNotCrash() {
        FrameMonitor.start()
        FrameMonitor.stop()

        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(FrameMonitor.isMonitoring())
        assertTrue(queuedCallbacks().isEmpty())
    }

    @Test
    fun stopRemovesTheScheduledCallback() {
        startAndDrain()
        assertEquals(1, queuedCallbacks().size)

        FrameMonitor.stop()
        FrameMonitor.stop()
        drain()

        assertFalse(FrameMonitor.isMonitoring())
        assertTrue(queuedCallbacks().isEmpty())
    }

    @Test
    fun rapidRestartLeavesOneRecurringCallback() {
        startAndDrain()
        val previous = queuedCallbacks().single()

        FrameMonitor.stop()
        FrameMonitor.start()
        drain()

        assertTrue(FrameMonitor.isMonitoring())
        assertNotSame(previous, queuedCallbacks().single())
        repeat(5) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
            assertEquals(1, queuedCallbacks().size)
        }
    }

    @Test
    fun queuedStartStopStartKeepsTheLastStart() {
        FrameMonitor.start()
        FrameMonitor.stop()
        FrameMonitor.start()
        drain()

        assertTrue(FrameMonitor.isMonitoring())
        assertEquals(1, queuedCallbacks().size)
    }

    @Test
    fun repeatedRestartsDoNotAccumulateCallbacks() {
        startAndDrain()
        repeat(50) {
            FrameMonitor.stop()
            FrameMonitor.start()
            drain()
            assertEquals(1, queuedCallbacks().size)
        }
    }

    @Test
    fun retainedCallbackCannotSampleOrRescheduleAfterRestart() {
        startAndDrain()
        val previous = queuedCallbacks().single()
        FrameMonitor.stop()
        FrameMonitor.start()
        drain()
        val current = queuedCallbacks().single()

        previous.doFrame(1_000_000_000L)
        previous.doFrame(2_100_000_000L)

        assertEquals(1, queuedCallbacks().size)
        assertSame(current, queuedCallbacks().single())
        assertEquals(FrameMonitor.FrozenFrameMetrics(0, 0.0), FrameMonitor.getAndResetFrozenMetrics())
    }

    @Test
    fun retainedCallbackCannotRestartStoppedMonitor() {
        startAndDrain()
        val previous = queuedCallbacks().single()
        FrameMonitor.stop()
        drain()

        previous.doFrame(1_000_000_000L)
        previous.doFrame(2_100_000_000L)

        assertTrue(queuedCallbacks().isEmpty())
        assertEquals(FrameMonitor.FrozenFrameMetrics(0, 0.0), FrameMonitor.getAndResetFrozenMetrics())
    }

    @Test
    fun repeatedStartPreservesCallbackAndUndrainedMetrics() {
        startAndDrain()
        val current = queuedCallbacks().single()
        frame(1_000_000_000L)
        frame(2_100_000_000L)

        FrameMonitor.start()
        drain()

        assertSame(current, queuedCallbacks().single())
        assertEquals(FrameMonitor.FrozenFrameMetrics(1, 1100.0), FrameMonitor.getAndResetFrozenMetrics())
        assertEquals(FrameMonitor.FrozenFrameMetrics(0, 0.0), FrameMonitor.getAndResetFrozenMetrics())
    }

    @Test
    fun restartResetsCountersAndDoesNotMeasureTheStoppedInterval() {
        startAndDrain()
        frame(1_000_000_000L)
        frame(2_100_000_000L)
        FrameMonitor.stop()
        FrameMonitor.start()
        drain()

        frame(10_000_000_000L)
        assertEquals(FrameMonitor.FrozenFrameMetrics(0, 0.0), FrameMonitor.getAndResetFrozenMetrics())
        frame(11_100_000_000L)
        assertEquals(FrameMonitor.FrozenFrameMetrics(1, 1100.0), FrameMonitor.getAndResetFrozenMetrics())
    }

    @Test
    fun workerThreadStartAndStopRespectQueueOrder() {
        Thread {
            repeat(50) { FrameMonitor.start(); FrameMonitor.stop() }
            FrameMonitor.start()
        }.apply { start(); join() }
        drain()
        assertEquals(1, queuedCallbacks().size)

        Thread { FrameMonitor.stop() }.apply { start(); join() }
        drain()
        assertTrue(queuedCallbacks().isEmpty())
    }

    @Test
    fun concurrentStartsRegisterOnlyOnce() {
        val threads = List(8) { Thread { repeat(20) { FrameMonitor.start() } } }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        drain()

        assertTrue(FrameMonitor.isMonitoring())
        assertEquals(1, queuedCallbacks().size)
    }

    @Test
    fun metricsReadWaitsForQueuedRestart() {
        startAndDrain()
        frame(1_000_000_000L)
        frame(2_100_000_000L)
        frame(2_160_000_000L)
        frame(2_170_000_000L)
        FrameMonitor.stop()
        FrameMonitor.start()
        var result: FrameMonitor.FrameMetrics? = null
        FrameMonitor.getFrameMetrics { result = it }
        assertNull(result)

        drain()

        assertEquals(0, result!!.frozenFrames)
        assertEquals(0.0, result!!.frozenDurationMs, 0.0)
        assertEquals(0, result!!.slowFrames)
    }

    @Test
    fun queuedMetricsReadsDrainEachCounterOnlyOnce() {
        startAndDrain()
        frame(1_000_000_000L)
        frame(2_100_000_000L)
        frame(2_160_000_000L)
        frame(2_170_000_000L)
        val results = mutableListOf<FrameMonitor.FrameMetrics>()
        FrameMonitor.getFrameMetrics { results.add(it) }
        FrameMonitor.getFrameMetrics { results.add(it) }
        drain()

        assertEquals(2, results.size)
        assertEquals(1, results[0].frozenFrames)
        assertEquals(1100.0, results[0].frozenDurationMs, 0.0)
        assertEquals(1, results[0].slowFrames)
        assertEquals(0, results[1].frozenFrames)
        assertEquals(0.0, results[1].frozenDurationMs, 0.0)
        assertEquals(0, results[1].slowFrames)
    }

    private fun startAndDrain() {
        FrameMonitor.start()
        drain()
    }

    private fun drain() = shadowOf(Looper.getMainLooper()).idle()

    private fun frame(timestamp: Long) {
        val callback = queuedCallbacks().single()
        Choreographer.getInstance().removeFrameCallback(callback)
        callback.doFrame(timestamp)
    }

    private fun queuedCallbacks(): List<Choreographer.FrameCallback> {
        // Inspect Android's queue: duplicate callbacks can share a timestamp and hide in metric counts.
        val queues = ReflectionHelpers.getField<Array<Any>>(Choreographer.getInstance(), "mCallbackQueues")
        var entry: Any? = ReflectionHelpers.getField(queues[1], "mHead")
        val callbacks = mutableListOf<Choreographer.FrameCallback>()
        while (entry != null) {
            val action = ReflectionHelpers.getField<Any>(entry, "action")
            if (action is Choreographer.FrameCallback) callbacks.add(action)
            entry = ReflectionHelpers.getField(entry, "next")
        }
        return callbacks
    }
}
