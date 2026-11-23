package com.grafana.faro.reactnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProcessUsageTest {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime ...
    private val statLine =
        "12345 (com.example.app) S 600 600 0 0 -1 1077952832 9000 0 12 0 150 50 7000 3000 20 0 30 0 4242 0 0"

    @Test
    fun parsesUtimePlusStimeWithoutChildTimes() {
        // utime 150 + stime 50; cutime 7000 and cstime 3000 belong to child processes.
        assertEquals(200L, ProcessUsage.parseProcStatCpuTicks(statLine))
    }

    @Test
    fun parsesCommandNamesWithSpacesAndParentheses() {
        val line = "42 (my ) (odd app name) R 1 1 0 0 -1 0 0 0 0 0 7 3 100 100 20 0"
        assertEquals(10L, ProcessUsage.parseProcStatCpuTicks(line))
    }

    @Test
    fun rejectsMalformedStatLines() {
        assertNull(ProcessUsage.parseProcStatCpuTicks(""))
        assertNull(ProcessUsage.parseProcStatCpuTicks("12345 com.example.app S 1 2 3"))
        assertNull(ProcessUsage.parseProcStatCpuTicks("12345 (app) S 600 600 0 0 -1 0 0 0 0 0 x 50"))
        assertNull(ProcessUsage.parseProcStatCpuTicks("12345 (app) S 600 600 0 0 -1 0 0 0 0 0 150"))
    }

    @Test
    fun parsesVmRssInBytes() {
        val status = sequenceOf(
            "Name:\tcom.example.app",
            "VmPeak:\t 9000000 kB",
            "VmRSS:\t  217497 kB",
            "RssAnon:\t  100000 kB",
        )
        assertEquals(217497.0 * 1024, ProcessUsage.parseVmRssBytes(status))
    }

    @Test
    fun returnsNullWhenVmRssIsMissingOrZero() {
        assertNull(ProcessUsage.parseVmRssBytes(sequenceOf("VmRSS:\t garbage kB")))
        assertNull(ProcessUsage.parseVmRssBytes(sequenceOf("Name:\tapp", "VmSize:\t 100 kB")))
        assertNull(ProcessUsage.parseVmRssBytes(sequenceOf("VmRSS:\t       0 kB")))
    }
}
