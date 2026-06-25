package com.grafana.faro.reactnative

import com.google.protobuf.CodedInputStream
import com.google.protobuf.InvalidProtocolBufferException
import com.google.protobuf.WireFormat

/**
 * Parses Android tombstone protobuf without generated [TombstoneProtos.Tombstone.parseFrom].
 *
 * Release builds (R8) can strip protobuf generated fields, breaking parseFrom even when the wire
 * bytes are valid. This parser is R8-safe.
 */
internal object TombstoneWireParser {

    private val architectureLabels = mapOf(
        0 to "arm",
        1 to "arm64",
        2 to "x86",
        3 to "x86_64",
        4 to "riscv64",
        5 to "unknown",
    )

    fun parse(bytes: ByteArray): ParsedTombstoneData? {
        if (bytes.isEmpty()) {
            return null
        }

        parseMessage(bytes)?.let { parsed ->
            if (parsed.threads.values.any { it.backtrace.isNotEmpty() }) {
                return parsed
            }
        }

        // Some Android builds wrap the tombstone in an outer message; scan nested payloads.
        for (nested in extractLengthDelimitedMessages(bytes)) {
            parseMessage(nested)?.let { parsed ->
                if (parsed.threads.values.any { it.backtrace.isNotEmpty() }) {
                    return parsed
                }
            }
        }

        return null
    }

    private fun parseMessage(bytes: ByteArray): ParsedTombstoneData? {
        return try {
            val input = CodedInputStream.newInstance(bytes)
            var arch = "unknown"
            var pid = 0
            var tid = 0
            var signalName = ""
            var signalNumber = 0
            var abortMessage = ""
            val threads = linkedMapOf<Int, ParsedThreadData>()
            val memoryMappings = mutableListOf<ParsedMemoryMapping>()

            while (true) {
                val tag = input.readTag()
                if (tag == 0) {
                    break
                }

                when (WireFormat.getTagFieldNumber(tag)) {
                    1 -> arch = architectureLabels[input.readEnum()] ?: "unknown"
                    5 -> pid = input.readUInt32()
                    6 -> tid = input.readUInt32()
                    10 -> parseSignal(input.readBytes().toByteArray())?.let { signal ->
                        signalName = signal.first
                        signalNumber = signal.second
                    }
                    14 -> abortMessage = input.readStringRequireUtf8()
                    16 -> parseThreadMapEntry(input.readBytes().toByteArray())?.let { (threadId, thread) ->
                        threads[threadId] = thread
                    }
                    17 -> memoryMappings.add(parseMemoryMapping(input.readBytes().toByteArray()))
                    else -> input.skipField(tag)
                }
            }

            ParsedTombstoneData(
                arch = arch,
                pid = pid,
                tid = tid,
                signalName = signalName,
                signalNumber = signalNumber,
                abortMessage = abortMessage,
                threads = threads,
                memoryMappings = memoryMappings,
            )
        } catch (_: InvalidProtocolBufferException) {
            null
        } catch (_: IndexOutOfBoundsException) {
            null
        }
    }

    private fun parseSignal(bytes: ByteArray): Pair<String, Int>? {
        val input = CodedInputStream.newInstance(bytes)
        var number = 0
        var name = ""
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            when (WireFormat.getTagFieldNumber(tag)) {
                1 -> number = input.readInt32()
                2 -> name = input.readStringRequireUtf8()
                else -> input.skipField(tag)
            }
        }
        return name to number
    }

    private fun parseThreadMapEntry(bytes: ByteArray): Pair<Int, ParsedThreadData>? {
        val input = CodedInputStream.newInstance(bytes)
        var threadId = 0
        var threadBytes: ByteArray? = null
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            when (WireFormat.getTagFieldNumber(tag)) {
                1 -> threadId = input.readUInt32()
                2 -> threadBytes = input.readBytes().toByteArray()
                else -> input.skipField(tag)
            }
        }
        val thread = threadBytes?.let { parseThread(it) } ?: return null
        return threadId to thread
    }

    private fun parseThread(bytes: ByteArray): ParsedThreadData {
        val input = CodedInputStream.newInstance(bytes)
        var id = 0
        var name = ""
        val backtrace = mutableListOf<ParsedBacktraceFrame>()
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            when (WireFormat.getTagFieldNumber(tag)) {
                1 -> id = input.readInt32()
                2 -> name = input.readStringRequireUtf8()
                4 -> backtrace.add(parseBacktraceFrame(input.readBytes().toByteArray()))
                else -> input.skipField(tag)
            }
        }
        return ParsedThreadData(id = id, name = name, backtrace = backtrace)
    }

    private fun parseBacktraceFrame(bytes: ByteArray): ParsedBacktraceFrame {
        val input = CodedInputStream.newInstance(bytes)
        var relPc = 0L
        var pc = 0L
        var functionName = ""
        var functionOffset = 0L
        var fileName = ""
        var buildId = ""
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            when (WireFormat.getTagFieldNumber(tag)) {
                1 -> relPc = input.readUInt64()
                2 -> pc = input.readUInt64()
                4 -> functionName = input.readStringRequireUtf8()
                5 -> functionOffset = input.readUInt64()
                6 -> fileName = input.readStringRequireUtf8()
                8 -> buildId = input.readStringRequireUtf8()
                else -> input.skipField(tag)
            }
        }
        return ParsedBacktraceFrame(
            relPc = relPc,
            pc = pc,
            functionName = functionName,
            functionOffset = functionOffset,
            fileName = fileName,
            buildId = buildId,
        )
    }

    private fun parseMemoryMapping(bytes: ByteArray): ParsedMemoryMapping {
        val input = CodedInputStream.newInstance(bytes)
        var beginAddress = 0L
        var endAddress = 0L
        var mappingName = ""
        var buildId = ""
        var loadBias = 0L
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            when (WireFormat.getTagFieldNumber(tag)) {
                1 -> beginAddress = input.readUInt64()
                2 -> endAddress = input.readUInt64()
                7 -> mappingName = input.readStringRequireUtf8()
                8 -> buildId = input.readStringRequireUtf8()
                9 -> loadBias = input.readUInt64()
                else -> input.skipField(tag)
            }
        }
        return ParsedMemoryMapping(
            beginAddress = beginAddress,
            endAddress = endAddress,
            mappingName = mappingName,
            buildId = buildId,
            loadBias = loadBias,
        )
    }

    private fun extractLengthDelimitedMessages(bytes: ByteArray): List<ByteArray> {
        val nested = mutableListOf<ByteArray>()
        val input = CodedInputStream.newInstance(bytes)
        while (true) {
            val tag = input.readTag()
            if (tag == 0) {
                break
            }
            if (WireFormat.getTagWireType(tag) == WireFormat.WIRETYPE_LENGTH_DELIMITED) {
                nested.add(input.readBytes().toByteArray())
            } else {
                input.skipField(tag)
            }
        }
        return nested
    }
}
