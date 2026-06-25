package com.grafana.faro.reactnative

import android.app.ApplicationExitInfo
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Reads and normalizes ApplicationExitInfo trace streams into text tombstones.
 */
internal object ApplicationExitTraceReader {

    private const val TAG = "FaroCrashReporter"
    private const val MAX_TRACE_BYTES = 512 * 1024
    private const val MAX_TRACE_LINES = 200

    data class ParsedExitTrace(
        val text: String,
        val signal: String = "",
        val source: TraceSource = TraceSource.NONE,
    )

    enum class TraceSource {
        NONE,
        TEXT_STREAM,
        PROTOBUF_TOMBSTONE,
        CACHED_NATIVE,
    }

    fun read(exitInfo: ApplicationExitInfo): ParsedExitTrace {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return ParsedExitTrace("")
        }

        return try {
            val traceInputStream = exitInfo.traceInputStream ?: return ParsedExitTrace("")
            val bytes = readAllBytes(traceInputStream)
            if (bytes.isEmpty()) {
                return ParsedExitTrace("")
            }

            parseTraceBytes(exitInfo, bytes)
        } catch (error: Exception) {
            Log.w(TAG, "Failed to read ApplicationExitInfo trace: ${error.message}")
            ParsedExitTrace("")
        }
    }

    fun parseTraceBytes(exitInfo: ApplicationExitInfo, bytes: ByteArray): ParsedExitTrace {
        val asText = decodeUtf8(bytes)
        if (TombstoneBacktraceFormatter.looksLikeTextTombstone(asText)) {
            Log.i(TAG, "[Faro crash native] Using text tombstone from ApplicationExitInfo (${asText.lineCount()} lines)")
            return ParsedExitTrace(
                text = trimTraceLines(asText),
                source = TraceSource.TEXT_STREAM,
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            exitInfo.reason == ApplicationExitInfo.REASON_CRASH_NATIVE
        ) {
            return parseProtobufTombstone(bytes)
        }

        if (asText.isNotBlank()) {
            return ParsedExitTrace(
                text = trimTraceLines(asText),
                source = TraceSource.TEXT_STREAM,
            )
        }

        return ParsedExitTrace("")
    }

    private fun parseProtobufTombstone(bytes: ByteArray): ParsedExitTrace {
        val parsed = TombstoneWireParser.parse(bytes)
        if (parsed == null) {
            Log.w(TAG, "[Faro crash native] Failed to parse tombstone protobuf (${bytes.size} bytes)")
            return ParsedExitTrace("")
        }

        val formatted = TombstoneBacktraceFormatter.format(parsed)
        if (formatted.text.isBlank()) {
            Log.w(TAG, "[Faro crash native] Tombstone protobuf parsed but backtrace was empty")
            return ParsedExitTrace("")
        }

        Log.i(
            TAG,
            "[Faro crash native] Decoded tombstone protobuf (${formatted.text.lineCount()} lines, signal=${formatted.signal})",
        )
        return ParsedExitTrace(
            text = trimTraceLines(formatted.text),
            signal = formatted.signal,
            source = TraceSource.PROTOBUF_TOMBSTONE,
        )
    }

    private fun readAllBytes(input: java.io.InputStream): ByteArray {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        var total = 0
        while (true) {
            val read = input.read(chunk)
            if (read <= 0) {
                break
            }
            total += read
            if (total > MAX_TRACE_BYTES) {
                Log.w(TAG, "ApplicationExitInfo trace exceeded ${MAX_TRACE_BYTES} bytes; truncating")
                buffer.write(chunk, 0, read.coerceAtMost(MAX_TRACE_BYTES - (total - read)))
                break
            }
            buffer.write(chunk, 0, read)
        }
        return buffer.toByteArray()
    }

    private fun decodeUtf8(bytes: ByteArray): String {
        if (bytes.isEmpty()) {
            return ""
        }
        if (bytes.any { it == 0.toByte() }) {
            return ""
        }
        return bytes.toString(Charsets.UTF_8).trim()
    }

    private fun trimTraceLines(text: String): String {
        return text.lineSequence()
            .take(MAX_TRACE_LINES)
            .joinToString("\n")
            .trim()
    }

    private fun String.lineCount(): Int {
        if (isEmpty()) {
            return 0
        }
        return lines().size
    }
}
