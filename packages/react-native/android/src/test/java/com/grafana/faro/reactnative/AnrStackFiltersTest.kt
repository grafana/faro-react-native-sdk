package com.grafana.faro.reactnative

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnrStackFiltersTest {

    @Test
    fun isCrashHandlerStack_detectsFrameworkCrashKillerFrames() {
        val stack = """
            at com.android.internal.os.RuntimeInit${'$'}KillApplicationHandler.uncaughtException(RuntimeInit.java:174)
            at java.lang.Thread.dispatchUncaughtException(Thread.java:2306)
        """.trimIndent()

        assertTrue(AnrStackFilters.isCrashHandlerStack(stack))
    }

    @Test
    fun isCrashHandlerStack_allowsBlockedAppFrames() {
        val stack = """
            at com.example.MainActivity.block(MainActivity.kt:42)
            at android.os.Handler.dispatchMessage(Handler.java:102)
        """.trimIndent()

        assertFalse(AnrStackFilters.isCrashHandlerStack(stack))
    }
}
