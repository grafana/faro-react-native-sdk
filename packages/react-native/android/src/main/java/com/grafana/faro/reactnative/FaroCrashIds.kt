package com.grafana.faro.reactnative

import java.security.MessageDigest

internal object FaroCrashIds {
    private const val SCHEMA_VERSION = 1

    fun sessionContextId(
        sessionId: String,
        activatedAtMs: Long,
        pid: Int,
        processName: String,
    ): String {
        return digest("context", sessionId, activatedAtMs, pid, processName)
    }

    fun reportId(
        packageName: String,
        timestampMs: Long,
        pid: Int,
        processName: String,
    ): String {
        return digest("report", packageName, timestampMs, pid, processName)
    }

    private fun digest(kind: String, vararg parts: Any): String {
        val input = buildString {
            append(SCHEMA_VERSION)
            append('|')
            append(kind)
            for (part in parts) {
                val value = part.toString()
                append('|')
                append(value.length)
                append(':')
                append(value)
            }
        }
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        return "v$SCHEMA_VERSION:$hash"
    }
}
