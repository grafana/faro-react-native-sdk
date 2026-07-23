package com.grafana.faro.reactnative

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
        val pending = FaroCrashTraceCache.peekPendingCrashTrace(context)

        assertEquals("", FaroCrashTraceCache.traceForExitTimestamp(context, pending, 1_000L))
        assertNotNull(FaroCrashTraceCache.peekPendingCrashTrace(context))
        assertEquals(
            "java.lang.RuntimeException",
            FaroCrashTraceCache.traceForExitTimestamp(context, pending, 20_000L),
        )
    }
}
