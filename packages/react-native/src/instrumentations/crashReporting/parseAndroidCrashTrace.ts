import type { ExceptionStackFrame } from '@grafana/faro-core';

import { parseStackTraceLine, toFaroStackFrames } from '../errors/stackTraceParser';

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

export interface ParsedAndroidCrashTrace {
  exceptionType?: string;
  /** Human-readable message from the trace header (e.g. the JS error text). */
  exceptionMessage?: string;
  /** JS/Hermes frames from the embedded RN stack (source-map targets). */
  jsFrames: ExceptionStackFrame[];
  /** Native Java/Kotlin frames (Android R8 retrace targets). */
  frames: AndroidCrashStackFrame[];
}

// Mirrors pkg/exporter/androidretrace/mapping.go frameLine / exceptionHeader.
const FRAME_LINE = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^):]*)(?::(\d+))?\)\s*$/;
const EXCEPTION_HEADER = /^\s*(?:Caused by:\s*)?([\w$.]+)(?::(.*))?$/;

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
  let exceptionType: string | undefined;
  let exceptionMessage: string | undefined;

  lines.forEach((line, index) => {
    const frameMatch = line.match(FRAME_LINE);

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

    if (index === 0 || line.trimStart().startsWith('Caused by:')) {
      const headerMatch = line.match(EXCEPTION_HEADER);
      if (headerMatch?.[1]) {
        exceptionType = headerMatch[1];
        exceptionMessage = normalizeCrashTraceExceptionMessage(headerMatch[2]);
      }
    }
  });

  if (frames.length === 0 && jsFrames.length === 0 && !exceptionType) {
    return null;
  }

  return { exceptionType, exceptionMessage, jsFrames, frames };
}
