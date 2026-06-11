package com.grafana.faro.reactnative

/**
 * Extracts the blocked main-thread stack from an ApplicationExitInfo ANR trace dump.
 *
 * Android emits a multi-thread text blob (see `ApplicationExitInfo.traceInputStream`).
 * Sentry-style ANR reporting uses the `"main"` thread section, not a live
 * [Thread.getStackTrace] snapshot from a watchdog thread.
 */
internal object AnrThreadDumpParser {

    private val threadHeader = Regex("^\"[^\"]+\".*prio=")
    private val frameWithAt = Regex("^at\\s+.+")
    private val frameWithoutAt = Regex("^[\\w$.]+\\.[\\w$<>]+\\(.+\\)\\s*$")

    fun extractMainThreadStack(fullDump: String): String {
        if (fullDump.isBlank()) {
            return ""
        }

        val lines = fullDump.lines()
        var inMain = false
        val stack = StringBuilder()

        for (line in lines) {
            val trimmed = line.trim()
            if (trimmed.isEmpty()) {
                continue
            }

            if (!inMain) {
                if (trimmed.startsWith("\"main\"") || trimmed == "main") {
                    inMain = true
                }
                continue
            }

            if (threadHeader.matches(trimmed) && !trimmed.startsWith("\"main\"")) {
                break
            }

            if (frameWithAt.matches(trimmed)) {
                stack.appendLine(if (line.startsWith("    ")) line else "    $trimmed")
                continue
            }

            if (frameWithoutAt.matches(trimmed)) {
                stack.appendLine("    at $trimmed")
            }
        }

        if (stack.isNotEmpty()) {
            return stack.toString().trim()
        }

        // Some devices return only flat "at …" lines without a DALVIK THREADS header.
        return extractFlatAtLines(fullDump)
    }

    private fun extractFlatAtLines(fullDump: String): String {
        val stack = StringBuilder()
        for (line in fullDump.lines()) {
            val trimmed = line.trim()
            if (frameWithAt.matches(trimmed)) {
                stack.appendLine(if (line.startsWith("    ")) line else "    $trimmed")
            }
        }
        return stack.toString().trim()
    }
}
