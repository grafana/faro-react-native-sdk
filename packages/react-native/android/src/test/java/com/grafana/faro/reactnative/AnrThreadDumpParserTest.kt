package com.grafana.faro.reactnative

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnrThreadDumpParserTest {

    @Test
    fun extractMainThreadStack_parsesDalvikThreadDump() {
        val dump = """
            "main" prio=5 tid=1 Runnable
              | group="main" sCount=0 ucsCount=0 flags=0 obj=0x0 self=0x0
              at com.example.MainActivity.block(MainActivity.kt:42)
              at android.app.Activity.performCreate(Activity.java:9000)
            "ReferenceQueueDaemon" prio=5 tid=6 Waiting
              at java.lang.Object.wait(Native method)
        """.trimIndent()

        val stack = AnrThreadDumpParser.extractMainThreadStack(dump)

        assertTrue(stack.contains("com.example.MainActivity.block"))
        assertFalse(stack.contains("ReferenceQueueDaemon"))
    }

    @Test
    fun extractMainThreadStack_parsesFlatAtLines() {
        val dump = """
            at com.example.MainActivity.block(MainActivity.kt:42)
            at android.app.Activity.performCreate(Activity.java:9000)
        """.trimIndent()

        val stack = AnrThreadDumpParser.extractMainThreadStack(dump)

        assertTrue(stack.contains("com.example.MainActivity.block(MainActivity.kt:42)"))
        assertTrue(stack.contains("android.app.Activity.performCreate(Activity.java:9000)"))
    }
}
