import type { ExceptionStackFrame } from '@grafana/faro-core';

import { parseStackTraceLine, toFaroStackFrames } from '../../errors/stackTraceParser';

/**
 * Android ApplicationExitInfo traces use Java/Kotlin stack-trace formatting.
 * Faro ingest expects structured frames with `module` (obfuscated class) so the
 * collector can R8-retrace them — not the JS call stack from sendCrashReport().
 *
 * Fatal RN JS errors also embed a short Hermes/Metro stack before native frames
 * (e.g. `anonymous@1:1390953`). Those lines are parsed as JS frames (no `module`)
 * so the collector can source-map them to files like DebugScreen.tsx.
 */
export interface AndroidCrashStackFrame extends ExceptionStackFrame {
  module: string;
}

export interface ParseAndroidCrashTraceOptions {
  releaseBundleFilename?: string;
}

export interface NativeTombstoneStackFrame extends ExceptionStackFrame {
  /** Unstripped .so basename (e.g. libappmodules.so) for NDK retrace on the collector. */
  module: string;
}

export interface ParsedAndroidCrashTrace {
  exceptionType?: string;
  /** Human-readable message from the trace header (e.g. the JS error text). */
  exceptionMessage?: string;
  /** JS/Hermes frames from the embedded RN stack (source-map targets). */
  jsFrames: ExceptionStackFrame[];
  /** Native Java/Kotlin frames (Android R8 retrace targets). */
  frames: AndroidCrashStackFrame[];
  /** NDK tombstone #NN pc lines (server-side .so retrace targets). */
  nativeFrames: NativeTombstoneStackFrame[];
}

// Mirrors pkg/exporter/androidretrace/mapping.go frameLine / exceptionHeader.
const FRAME_LINE = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^):]*)(?::(\d+))?\)\s*$/;
// Thread.getStackTrace() / legacy ANRTracker lines without the "at " prefix.
const THREAD_STACK_FRAME_LINE = /^\s*([\w$.]+)\.([\w$<>]+)\(([^):]*)(?::(\d+))?\)\s*$/;
const EXCEPTION_HEADER = /^\s*(?:Caused by:\s*)?([\w$.]+)(?::(.*))?$/;
// Mirrors pkg/exporter/androidretrace/native_frame.go nativeFrameLine.
const NATIVE_TOMBSTONE_FRAME_LINE =
  /^\s*#(\d+)\s+pc\s+(?:0x)?([0-9a-fA-F]+)\s+(\S+)(?:\s+\(([^)]+)\))?/i;

const TOMBSTONE_SECTION_LABELS = new Set(['backtrace', 'stack', 'build id', 'memory map', 'memory near', 'abi']);

/** Tombstone section headers and metadata must not become exception_type / nativeExceptionType. */
export function isTombstoneSectionLabel(value: string): boolean {
  return TOMBSTONE_SECTION_LABELS.has(value.trim().toLowerCase());
}

function isTombstoneMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith('***')) {
    return true;
  }
  if (/^ABI:/i.test(trimmed)) {
    return true;
  }
  if (/^signal\s+/i.test(trimmed)) {
    return true;
  }
  if (/^pid:/i.test(trimmed)) {
    return true;
  }
  if (isTombstoneSectionLabel(trimmed.replace(/:$/, ''))) {
    return true;
  }
  return false;
}

function nativeLibBasename(token: string): string {
  const bang = token.lastIndexOf('!');
  if (bang >= 0) {
    token = token.slice(bang + 1);
  }
  const slash = token.lastIndexOf('/');
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function parseNativeTombstoneFrameLine(line: string): NativeTombstoneStackFrame | null {
  const match = line.match(NATIVE_TOMBSTONE_FRAME_LINE);
  if (!match) {
    return null;
  }

  const library = match[3] ?? '';
  const suffix = match[4]?.trim();
  let fn = '<unknown>';
  if (suffix) {
    const fnMatch = suffix.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\+(\d+))?$/);
    if (fnMatch?.[1] && fnMatch[1] !== 'BuildId' && fnMatch[1] !== 'offset') {
      fn = fnMatch[1];
    }
  }

  return {
    module: nativeLibBasename(library),
    function: fn,
    filename: nativeLibBasename(library),
  };
}

/** Reject version tokens (e.g. "18.2213") and other non-class header lines. */
export function isPlausibleJavaExceptionIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) {
    return false;
  }
  if (/^\d+(\.\d+)+$/.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Normalize raw Java thread stacks (e.g. ANRTracker) to Log.getStackTraceString shape
 * so collector R8 retrace (mapping.RetraceText) can rewrite frame lines.
 */
export function normalizeJavaStackTraceForRetrace(trace: string): string {
  return trace
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (/^\s*at\s+/.test(line)) {
        return line;
      }
      if (THREAD_STACK_FRAME_LINE.test(trimmed)) {
        return `    at ${trimmed}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Normalize exception text from ApplicationExitInfo / Log.getStackTraceString headers.
 *
 * React Native fatal JS errors embed the JS message in a fixed header shape
 * (`Error: <message>, stack:`) regardless of the wrapping Java exception class.
 * Match on that shape instead of the exception type name.
 */
const RN_FATAL_JS_ERROR_HEADER = /^Error:\s*(.+?),\s*stack:\s*$/i;

export function normalizeCrashTraceExceptionMessage(rawMessage: string | undefined): string | undefined {
  if (!rawMessage?.trim()) {
    return undefined;
  }

  const message = rawMessage.trim();
  const rnFatalMatch = message.match(RN_FATAL_JS_ERROR_HEADER);

  return (rnFatalMatch?.[1] ?? message).trim() || undefined;
}

function parseJsFrameLine(line: string, options?: ParseAndroidCrashTraceOptions): ExceptionStackFrame | null {
  const parsed = parseStackTraceLine(line);
  if (!parsed) {
    return null;
  }

  return toFaroStackFrames([parsed], options)[0] ?? null;
}

/**
 * Parse a raw Android crash trace into structured stack frames for pushError().
 */
export function parseAndroidCrashTrace(
  trace: string,
  options?: ParseAndroidCrashTraceOptions
): ParsedAndroidCrashTrace | null {
  const trimmed = trace.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split('\n');
  const jsFrames: ExceptionStackFrame[] = [];
  const frames: AndroidCrashStackFrame[] = [];
  const nativeFrames: NativeTombstoneStackFrame[] = [];
  let exceptionType: string | undefined;
  let exceptionMessage: string | undefined;

  lines.forEach((line) => {
    const nativeFrame = parseNativeTombstoneFrameLine(line);
    if (nativeFrame) {
      nativeFrames.push(nativeFrame);
      return;
    }

    const frameMatch = line.match(FRAME_LINE) ?? line.trim().match(THREAD_STACK_FRAME_LINE);

    if (frameMatch) {
      const [, module, method, filename, lineNo] = frameMatch;
      frames.push({
        module: module ?? '',
        function: method ?? '<unknown>',
        filename: filename?.trim() || 'SourceFile',
        lineno: lineNo ? parseInt(lineNo, 10) : undefined,
      });
      return;
    }

    const jsFrame = parseJsFrameLine(line, options);
    if (jsFrame) {
      jsFrames.push(jsFrame);
      return;
    }

    const headerMatch = line.match(EXCEPTION_HEADER);
    if (
      !isTombstoneMetadataLine(line) &&
      headerMatch?.[1] &&
      isPlausibleJavaExceptionIdentifier(headerMatch[1]) &&
      !isTombstoneSectionLabel(headerMatch[1])
    ) {
      exceptionType = headerMatch[1];
      exceptionMessage = normalizeCrashTraceExceptionMessage(headerMatch[2]);
    }
  });

  if (frames.length === 0 && jsFrames.length === 0 && nativeFrames.length === 0 && !exceptionType) {
    return null;
  }

  return { exceptionType, exceptionMessage, jsFrames, frames, nativeFrames };
}
