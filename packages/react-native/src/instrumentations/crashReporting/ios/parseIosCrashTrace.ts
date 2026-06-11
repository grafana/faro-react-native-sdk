import type { ExceptionStackFrame } from '@grafana/faro-core';

/**
 * iOS PLCrashReporter stack frames include library name and instruction pointers.
 * Format: "0  libsystem_kernel.dylib  0x00000001a2b3c000"
 */
export interface IosCrashStackFrame extends ExceptionStackFrame {
  /** Library/module name (e.g., "MyApp", "UIKitCore") */
  module: string;
  /** Instruction pointer address (hex string) */
  instructionPointer?: string;
  /** Library base address (hex string) */
  libraryBaseAddress?: string;
}

export interface ParseIosCrashTraceOptions {
  releaseBundleFilename?: string;
}

export interface ParsedIosCrashTrace {
  /** Signal name (e.g., "SIGSEGV", "SIGABRT") */
  signalName?: string;
  /** Human-readable signal description */
  signalDescription?: string;
  /** Exception name for uncaught exceptions (e.g., "NSInternalInconsistencyException") */
  exceptionName?: string;
  /** Exception reason/message for uncaught exceptions */
  exceptionReason?: string;
  /** iOS native frames (library + instruction pointer for symbolication) */
  frames: IosCrashStackFrame[];
}

/**
 * iOS PLCrashReporter stack trace line format:
 * "0  libsystem_kernel.dylib  0x00000001a2b3c000"
 * frame_number  library_name  instruction_pointer
 */
const IOS_STACK_FRAME_LINE = /^\s*(\d+)\s+(.+?)\s+(0x[0-9a-fA-F]+)\s*$/;

/**
 * Parse a raw iOS crash trace from PLCrashReporter into structured stack frames.
 *
 * iOS crashes from PLCrashReporter come with formatted stack traces where each line
 * contains: frame number, library name, and instruction pointer hex address.
 *
 * The collector will use the library name and instruction pointer for symbolication
 * with dSYM files or Breakpad symbols.
 */
export function parseIosCrashTrace(trace: string, _options?: ParseIosCrashTraceOptions): ParsedIosCrashTrace | null {
  const trimmed = trace.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split('\n');
  const frames: IosCrashStackFrame[] = [];

  for (const line of lines) {
    const frameMatch = line.match(IOS_STACK_FRAME_LINE);

    if (frameMatch) {
      const [, frameNumber, libraryName, instructionPointer] = frameMatch;

      if (!libraryName || !instructionPointer || !frameNumber) {
        continue;
      }

      frames.push({
        module: libraryName.trim(),
        function: instructionPointer,
        filename: libraryName.trim(),
        lineno: parseInt(frameNumber, 10),
        instructionPointer: instructionPointer,
      });
    }
  }

  if (frames.length === 0) {
    return null;
  }

  return { frames };
}
