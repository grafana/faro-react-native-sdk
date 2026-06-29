package com.grafana.faro.reactnative

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroAnrCacheTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("com.grafana.faro.anr_cache", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    @Test
    fun savePendingAnr_dedupesExactTimestamp() {
        val payload = """{"type":"ANR","timestamp":1000,"stacktrace":"at foo"}"""

        FaroAnrCache.savePendingAnr(context, payload)
        FaroAnrCache.savePendingAnr(context, payload)

        assertEquals(1, FaroAnrCache.getPendingAnrs(context).size)
    }

    @Test
    fun savePendingAnr_collapsesNearbyTimestamps() {
        FaroAnrCache.savePendingAnr(
            context,
            """{"type":"ANR","timestamp":1000,"stacktrace":"at foo"}""",
        )
        FaroAnrCache.savePendingAnr(
            context,
            """{"type":"ANR","timestamp":6000,"stacktrace":"at bar"}""",
        )

        assertEquals(1, FaroAnrCache.getPendingAnrs(context).size)
    }

    @Test
    fun hasNearbyAnrDetection_matchesWithinWindow() {
        FaroAnrCache.savePendingAnr(
            context,
            """{"type":"ANR","timestamp":1000,"stacktrace":"at foo"}""",
        )

        assertTrue(FaroAnrCache.hasNearbyAnrDetection(context, 5000))
        assertFalse(FaroAnrCache.hasNearbyAnrDetection(context, 20000))
    }

    @Test
    fun acknowledgeAnrs_removesMatchingEntries() {
        FaroAnrCache.savePendingAnr(
            context,
            """{"type":"ANR","timestamp":1000,"stacktrace":"at foo"}""",
        )
        FaroAnrCache.savePendingAnr(
            context,
            """{"type":"ANR","timestamp":20000,"stacktrace":"at bar"}""",
        )

        FaroAnrCache.acknowledgeAnrs(context, listOf(1000L))

        val remaining = FaroAnrCache.getPendingAnrs(context)
        assertEquals(1, remaining.size)
        assertTrue(remaining[0].contains("\"timestamp\":20000"))
    }
}
