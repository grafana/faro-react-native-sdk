package com.grafana.faro.reactnative

import android.system.Os
import android.system.OsConstants
import java.io.File

/**
 * Raw CPU and memory readings of the app process for `app.cpu_usage` and `app.memory`.
 *
 * JavaScript turns two CPU readings into the utilization of one window:
 * `100 × Δ cpuTimeMs ÷ (Δ monotonicMs × logicalCpuCount)`.
 *
 * - CPU time: `utime + stime` from `/proc/self/stat`, in clock ticks converted with `_SC_CLK_TCK`.
 *   The kernel keeps the time of exited threads in these process totals. `cutime` and `cstime`
 *   (waited-for child processes) are not included.
 * - Clock: `SystemClock.elapsedRealtimeNanos()`, monotonic.
 * - CPU count: `Runtime.availableProcessors()`, read with each sample.
 * - Memory: `VmRSS` from `/proc/self/status`, in bytes.
 *
 * Reads are called by the module-owned background executor.
 */
object ProcessUsage {
    private val vmRssPattern = Regex("""^VmRSS:\s+(\d+)\s+kB""")

    @Volatile
    private var clockTicksPerSecond: Long = 0

    fun readCpuTimeMs(): Double? {
        val ticksPerSecond = clockTicks() ?: return null
        val statLine = readFirstLine(File("/proc/self/stat")) ?: return null
        val ticks = parseProcStatCpuTicks(statLine) ?: return null
        return ticks * 1000.0 / ticksPerSecond
    }

    /** VmRSS in bytes, or null when it cannot be read. */
    fun readMemoryBytes(): Double? {
        return try {
            File("/proc/self/status").useLines { lines -> parseVmRssBytes(lines) }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * `utime + stime` in clock ticks from one `/proc/<pid>/stat` line.
     *
     * The command name (field 2) is in parentheses and may contain spaces, so fields are counted
     * after the last `)`. `utime` is field 14 and `stime` field 15.
     */
    fun parseProcStatCpuTicks(statLine: String): Long? {
        val commEnd = statLine.lastIndexOf(')')
        if (commEnd < 0) {
            return null
        }
        val fields = statLine.substring(commEnd + 1).trim().split(Regex("\\s+"))
        // fields[0] is field 3 (state), so field n is fields[n - 3].
        val utime = fields.getOrNull(14 - 3)?.toLongOrNull() ?: return null
        val stime = fields.getOrNull(15 - 3)?.toLongOrNull() ?: return null
        if (utime < 0 || stime < 0) {
            return null
        }
        return utime + stime
    }

    /** VmRSS in bytes from `/proc/<pid>/status` lines (the kernel reports KiB as "kB"). */
    fun parseVmRssBytes(lines: Sequence<String>): Double? {
        for (line in lines) {
            val match = vmRssPattern.find(line) ?: continue
            val kib = match.groupValues[1].toLongOrNull() ?: return null
            return if (kib > 0) kib * 1024.0 else null
        }
        return null
    }

    private fun clockTicks(): Long? {
        if (clockTicksPerSecond <= 0) {
            clockTicksPerSecond = try {
                Os.sysconf(OsConstants._SC_CLK_TCK)
            } catch (_: Exception) {
                0
            }
        }
        return clockTicksPerSecond.takeIf { it > 0 }
    }

    private fun readFirstLine(file: File): String? {
        return try {
            file.bufferedReader().use { it.readLine() }
        } catch (_: Exception) {
            null
        }
    }
}
