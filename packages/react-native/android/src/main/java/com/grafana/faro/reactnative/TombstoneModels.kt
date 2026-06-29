package com.grafana.faro.reactnative

internal data class ParsedTombstoneData(
    val arch: String = "unknown",
    val pid: Int = 0,
    val tid: Int = 0,
    val signalName: String = "",
    val signalNumber: Int = 0,
    val abortMessage: String = "",
    val threads: Map<Int, ParsedThreadData> = emptyMap(),
    val memoryMappings: List<ParsedMemoryMapping> = emptyList(),
)

internal data class ParsedThreadData(
    val id: Int = 0,
    val name: String = "",
    val backtrace: List<ParsedBacktraceFrame> = emptyList(),
)

internal data class ParsedBacktraceFrame(
    val relPc: Long = 0L,
    val pc: Long = 0L,
    val functionName: String = "",
    val functionOffset: Long = 0L,
    val fileName: String = "",
    val buildId: String = "",
)

internal data class ParsedMemoryMapping(
    val beginAddress: Long = 0L,
    val endAddress: Long = 0L,
    val mappingName: String = "",
    val buildId: String = "",
    val loadBias: Long = 0L,
)
