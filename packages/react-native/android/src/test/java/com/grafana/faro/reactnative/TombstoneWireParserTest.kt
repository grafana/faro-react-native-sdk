package com.grafana.faro.reactnative

import com.grafana.faro.reactnative.tombstone.TombstoneProtos
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TombstoneWireParserTest {

    @Test
    fun parse_roundTripsGeneratedTombstoneBytes() {
        val frame = TombstoneProtos.BacktraceFrame.newBuilder()
            .setPc(0x1234)
            .setFileName("/data/app/lib/arm64-v8a/libappmodules.so")
            .setFunctionName("Java_com_example_NativeCrashModule_nativeCrash")
            .setFunctionOffset(8)
            .setBuildId("abc123")
            .build()

        val thread = TombstoneProtos.Thread.newBuilder()
            .setId(123)
            .setName("QuickPizza")
            .addCurrentBacktrace(frame)
            .build()

        val tombstone = TombstoneProtos.Tombstone.newBuilder()
            .setArch(TombstoneProtos.Architecture.ARM64)
            .setPid(1000)
            .setTid(123)
            .setSignalInfo(
                TombstoneProtos.Signal.newBuilder()
                    .setName("SIGSEGV")
                    .setNumber(11)
                    .build(),
            )
            .putThreads(123, thread)
            .setAbortMessage("null pointer dereference")
            .build()

        val parsed = TombstoneWireParser.parse(tombstone.toByteArray())
        assertNotNull(parsed)

        val formatted = TombstoneBacktraceFormatter.format(parsed!!)
        assertTrue(formatted.text.contains("ABI: 'arm64'"))
        assertTrue(formatted.text.contains("signal SIGSEGV (11)"))
        assertTrue(formatted.text.contains("#00 pc 0000000000001234  /data/app/lib/arm64-v8a/libappmodules.so"))
        assertEquals("SIGSEGV (11)", formatted.signal)
        assertTrue(TombstoneBacktraceFormatter.looksLikeNativeBacktrace(formatted.text))
    }
}
