package com.grafana.faro.reactnative

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroCrashTraceCacheTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(
            "com.grafana.faro.crash_trace_cache",
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
    }

    @Test
    fun timestampMismatchDoesNotClearTraceForLaterMatchingReport() {
        FaroCrashTraceCache.savePendingCrashTrace(context, "java.lang.RuntimeException", 20_000L)
        val pending = FaroCrashTraceCache.peekPendingCrashTrace(context, 20_001L)

        assertEquals("", FaroCrashTraceCache.traceForExitTimestamp(context, pending, 1_000L))
        assertNotNull(FaroCrashTraceCache.peekPendingCrashTrace(context, 20_001L))
        assertEquals(
            "java.lang.RuntimeException",
            FaroCrashTraceCache.traceForExitTimestamp(context, pending, 20_000L),
        )
    }

    @Test
    fun traceExpiresAfterReplayWindow() {
        val timestamp = 20_000L
        val replayWindow = FaroCrashSessionStore.MAX_CONTEXT_AGE_MS
        FaroCrashTraceCache.savePendingCrashTrace(context, "java.lang.RuntimeException", timestamp)

        assertNotNull(FaroCrashTraceCache.peekPendingCrashTrace(context, timestamp + replayWindow))
        assertNull(FaroCrashTraceCache.peekPendingCrashTrace(context, timestamp + replayWindow + 1L))
        assertNull(FaroCrashTraceCache.peekPendingCrashTrace(context, timestamp + replayWindow + 1L))
    }
}
