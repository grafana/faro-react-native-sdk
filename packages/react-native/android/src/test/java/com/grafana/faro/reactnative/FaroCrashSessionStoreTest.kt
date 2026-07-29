package com.grafana.faro.reactnative

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroCrashSessionStoreTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(
            "com.grafana.faro.crash_session_store",
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
    }

    @Test
    fun recordSessionContext_preservesFirstActivationForSessionUpdates() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L)
        recordSession("session-a", activatedAtMs = 2_000L, nowMs = 2_000L)

        val contexts = FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 2_000L)

        assertEquals(1, contexts.size)
        assertEquals(1_000L, contexts.single().activatedAtMs)
        assertEquals(2_000L, contexts.single().updatedAtMs)
    }

    @Test
    fun findMatchingContext_usesLatestSessionBeforeCrashInSameProcess() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L)
        recordSession("session-b", activatedAtMs = 3_000L, nowMs = 3_000L)

        val sessionA = FaroCrashSessionStore.findMatchingContext(
            context,
            crashTimestampMs = 2_000L,
            pid = 101,
            processName = "com.example.app",
            nowMs = 4_000L,
        )
        val sessionB = FaroCrashSessionStore.findMatchingContext(
            context,
            crashTimestampMs = 4_000L,
            pid = 101,
            processName = "com.example.app",
            nowMs = 4_000L,
        )

        assertEquals("session-a", sessionA?.sessionId)
        assertEquals("session-b", sessionB?.sessionId)
    }

    @Test
    fun findMatchingContext_doesNotCrossProcessBoundaries() {
        recordSession(
            sessionId = "session-a",
            activatedAtMs = 1_000L,
            nowMs = 1_000L,
            pid = 101,
        )
        recordSession(
            sessionId = "session-b",
            activatedAtMs = 2_000L,
            nowMs = 2_000L,
            pid = 202,
        )

        val match = FaroCrashSessionStore.findMatchingContext(
            context,
            crashTimestampMs = 3_000L,
            pid = 101,
            processName = "com.example.app",
            nowMs = 3_000L,
        )

        assertEquals("session-a", match?.sessionId)
    }

    @Test
    fun acknowledgeReports_removesOnlyItsOwnSessionContext() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L, pid = 101)
        recordSession("session-b", activatedAtMs = 2_000L, nowMs = 2_000L, pid = 202)
        val contexts = FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 3_000L)
        val sessionA = contexts.first { it.sessionId == "session-a" }
        val sessionB = contexts.first { it.sessionId == "session-b" }

        FaroCrashSessionStore.rememberPendingReport(
            context,
            reportId = "report-a",
            crashTimestampMs = 1_500L,
            sessionContext = sessionA,
            usesPendingTrace = true,
            nowMs = 3_000L,
        )
        FaroCrashSessionStore.rememberPendingReport(
            context,
            reportId = "report-b",
            crashTimestampMs = 2_500L,
            sessionContext = sessionB,
            usesPendingTrace = false,
            nowMs = 3_000L,
        )

        val result = FaroCrashSessionStore.acknowledgeReports(
            context,
            reportIds = listOf("report-a"),
            nowMs = 4_000L,
        )

        val remaining = FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 4_000L)
        assertTrue(result.clearPendingTrace)
        assertTrue(FaroCrashSessionStore.isReportAcknowledged(context, "report-a", nowMs = 4_000L))
        assertFalse(FaroCrashSessionStore.isReportAcknowledged(context, "report-b", nowMs = 4_000L))
        assertEquals(listOf("session-b"), remaining.map { it.sessionId })
        assertEquals(
            "session-b",
            FaroCrashSessionStore.contextForPendingReport(context, "report-b", nowMs = 4_000L)?.sessionId,
        )
    }

    @Test
    fun acknowledgeReports_keepsContextReferencedByAnotherPendingReport() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L)
        val sessionA = FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 2_000L).single()
        FaroCrashSessionStore.rememberPendingReport(
            context,
            "report-a",
            1_500L,
            sessionA,
            usesPendingTrace = false,
            nowMs = 2_000L,
        )
        FaroCrashSessionStore.rememberPendingReport(
            context,
            "report-b",
            1_600L,
            sessionA,
            usesPendingTrace = false,
            nowMs = 2_000L,
        )

        FaroCrashSessionStore.acknowledgeReports(context, listOf("report-a"), nowMs = 3_000L)

        assertEquals(
            "session-a",
            FaroCrashSessionStore.contextForPendingReport(context, "report-b", nowMs = 3_000L)?.sessionId,
        )
    }

    @Test
    fun acknowledgeReports_clearsSharedTraceOnlyAfterLastReferencingReport() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L)
        val sessionA = FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 2_000L).single()
        FaroCrashSessionStore.rememberPendingReport(
            context,
            "report-a",
            1_500L,
            sessionA,
            usesPendingTrace = true,
            nowMs = 2_000L,
        )
        FaroCrashSessionStore.rememberPendingReport(
            context,
            "report-b",
            1_600L,
            sessionA,
            usesPendingTrace = true,
            nowMs = 2_000L,
        )

        val first = FaroCrashSessionStore.acknowledgeReports(context, listOf("report-a"), nowMs = 3_000L)
        val second = FaroCrashSessionStore.acknowledgeReports(context, listOf("report-b"), nowMs = 4_000L)

        assertTrue(first.persisted)
        assertFalse(first.clearPendingTrace)
        assertTrue(second.persisted)
        assertTrue(second.clearPendingTrace)
    }

    @Test
    fun acknowledgeReports_canTombstoneAnIgnoredReportWithoutPendingContext() {
        val result = FaroCrashSessionStore.acknowledgeReports(
            context,
            reportIds = listOf("ignored-report"),
            nowMs = 1_000L,
        )

        assertTrue(result.persisted)
        assertFalse(result.clearPendingTrace)
        assertTrue(FaroCrashSessionStore.isReportAcknowledged(context, "ignored-report", nowMs = 1_000L))
    }

    @Test
    fun sessionContextExpiresOnlyAfterSevenDayBoundary() {
        val sevenDays = FaroCrashSessionStore.MAX_CONTEXT_AGE_MS
        recordSession("at-boundary", activatedAtMs = 1L, nowMs = 1_000L)

        assertEquals(
            1,
            FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 1_000L + sevenDays).size,
        )
        assertTrue(
            FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 1_001L + sevenDays).isEmpty(),
        )
    }

    @Test
    fun malformedStorageDoesNotPreventNewContextFromBeingRecorded() {
        context.getSharedPreferences(
            "com.grafana.faro.crash_session_store",
            Context.MODE_PRIVATE,
        ).edit().putString("session_contexts", "not-json").commit()

        assertTrue(recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L))
        assertEquals(
            "session-a",
            FaroCrashSessionStore.sessionContextsForTest(context, nowMs = 1_000L).single().sessionId,
        )
    }

    @Test
    fun findMatchingContext_returnsNullWithoutUsableProcessIdentity() {
        recordSession("session-a", activatedAtMs = 1_000L, nowMs = 1_000L)

        val match = FaroCrashSessionStore.findMatchingContext(
            context,
            crashTimestampMs = 2_000L,
            pid = 0,
            processName = "",
            nowMs = 2_000L,
        )

        assertNull(match)
    }

    private fun recordSession(
        sessionId: String,
        activatedAtMs: Long,
        nowMs: Long,
        pid: Int = 101,
    ): Boolean {
        return FaroCrashSessionStore.recordSessionContext(
            context = context,
            sessionId = sessionId,
            activatedAtMs = activatedAtMs,
            isSampled = true,
            appVersion = "1.0.0",
            appRelease = "42",
            appBundleId = "com.example.app@42@1.0.0",
            nowMs = nowMs,
            pid = pid,
            processName = "com.example.app",
        )
    }
}
