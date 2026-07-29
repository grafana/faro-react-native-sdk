package com.grafana.faro.reactnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FaroCrashReporterTest {

    @Test
    fun reportId_isStableForSameProcessCrash() {
        val first = FaroCrashIds.reportId(
            packageName = "com.example.app",
            timestampMs = 1_000L,
            pid = 101,
            processName = "com.example.app",
        )
        val second = FaroCrashIds.reportId(
            packageName = "com.example.app",
            timestampMs = 1_000L,
            pid = 101,
            processName = "com.example.app",
        )

        assertEquals(first, second)
        assertTrue(first.startsWith("v1:"))
        assertEquals(67, first.length)
    }

    @Test
    fun reportId_distinguishesProcessesAtSameTimestamp() {
        val first = FaroCrashIds.reportId(
            packageName = "com.example.app",
            timestampMs = 1_000L,
            pid = 101,
            processName = "com.example.app",
        )
        val second = FaroCrashIds.reportId(
            packageName = "com.example.app",
            timestampMs = 1_000L,
            pid = 202,
            processName = "com.example.app:worker",
        )

        assertNotEquals(first, second)
    }

    @Test
    fun replayWindow_includesExactSevenDayBoundary() {
        val nowMs = 1_000_000_000L
        val sevenDays = FaroCrashSessionStore.MAX_CONTEXT_AGE_MS

        assertTrue(FaroCrashReporter.isWithinReplayWindow(nowMs - sevenDays, nowMs))
        assertFalse(FaroCrashReporter.isWithinReplayWindow(nowMs - sevenDays - 1L, nowMs))
        assertFalse(FaroCrashReporter.isWithinReplayWindow(0L, nowMs))
        assertFalse(FaroCrashReporter.isWithinReplayWindow(nowMs + 1L, nowMs))
    }
}
