import { Platform } from 'react-native';

import type { ExceptionStackFrame as StackFrame } from '@grafana/faro-core';

// Declare global Hermes runtime
declare const HermesInternal: object | undefined;

/**
 * Parse React Native stack traces into structured stack frames
 *
 * React Native stack traces have different formats depending on platform and environment:
 *
 * iOS/Android (Dev):
 *   at functionName (file.js:123:45)
 *   at anonymous (native)
 *
 * iOS/Android (Release):
 *   functionName@123:456
 *   @[native code]
 *
 * Metro bundler:
 *   at Object.functionName (/path/to/file.js:123:456)
 */

const REACT_NATIVE_STACK_REGEX = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/;
const REACT_NATIVE_NATIVE_REGEX = /^\s*at\s+(.+?)\s+\(native\)$/;
const REACT_NATIVE_RELEASE_REGEX = /^(.+?)@(\d+):(\d+)$/;
const REACT_NATIVE_ANONYMOUS_REGEX = /^\s*at\s+anonymous\s+\((.+?):(\d+):(\d+)\)$/;
const METRO_BUNDLER_REGEX = /^\s*at\s+(?:Object\.)?(.+?)\s+\((.+?):(\d+):(\d+)\)$/;

/**
 * Hermes (Android release) often reports the bundle segment as `address at index.android.bundle`
 * inside parentheses. The collector hashes `frame.filename` for uploaded maps; it must match the
 * source map `file` field (e.g. `index.android.bundle`), not the verbose Hermes label.
 */
export function normalizeHermesStackFilename(filename: string): string {
  const trimmed = filename.trim();
  const m = /^address\s+at\s+(.+)$/i.exec(trimmed);
  return m?.[1]?.trim() ?? filename;
}

/**
 * iOS Simulator (and Android) stacks often carry full filesystem paths such as
 * `…/Foo.app/main.jsbundle` while uploaded maps are keyed by the bundle basename (`main.jsbundle`)
 * that matches Metro’s source map `file` field — same as ingest’s bundle lookup hashes.
 */
function collapseBundledArtifactPath(filename: string, releaseBasename: string): string {
  const key = releaseBasename.trim();
  if (!key || filename === key) {
    return filename;
  }
  const suffix = `/${key}`;
  return filename.endsWith(suffix) ? key : filename;
}

export interface ParsedStackFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  isNative?: boolean;
  /** Set when the line matched Hermes/minified `func@line:col` (no path). */
  releaseLine?: boolean;
}

/** Which parser branch handled a stack line (internal). */
type ParsedStackLineKind =
  | 'react_native_paren'
  | 'metro_paren'
  | 'anonymous_paren'
  | 'native'
  | 'release_func_at'
  | 'unparsed';

const UNKNOWN_RELEASE_FILENAME = '<unknown>';

export interface StackFrameParseOptions {
  /**
   * Hermes / minified RN release lines use `func@line:col` with no file path. Those frames are tagged
   * with `releaseLine` and use this as `filename` (default `bundle.js`). Match the Metro plugin’s
   * source map `file` field (or `sourceMapFile` option there).
   */
  releaseBundleFilename?: string;
}

/**
 * Parse a single stack trace line into a structured frame and record how it was parsed.
 */
function parseStackTraceLineDetailed(
  line: string
): { frame: ParsedStackFrame | null; kind: ParsedStackLineKind } {
  if (!line || typeof line !== 'string') {
    return { frame: null, kind: 'unparsed' };
  }

  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return { frame: null, kind: 'unparsed' };
  }

  // Try standard React Native format: at functionName (file.js:123:45)
  let match = trimmedLine.match(REACT_NATIVE_STACK_REGEX);
  if (match && match[2] && match[3] && match[4]) {
    return {
      kind: 'react_native_paren',
      frame: {
        function: match[1] || '<anonymous>',
        filename: normalizeHermesStackFilename(match[2]),
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
      },
    };
  }

  // Try Metro bundler format: at Object.functionName (/path/to/file.js:123:456)
  match = trimmedLine.match(METRO_BUNDLER_REGEX);
  if (match && match[2] && match[3] && match[4]) {
    return {
      kind: 'metro_paren',
      frame: {
        function: match[1] || '<anonymous>',
        filename: normalizeHermesStackFilename(match[2]),
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
      },
    };
  }

  // Try anonymous format: at anonymous (file.js:123:45)
  match = trimmedLine.match(REACT_NATIVE_ANONYMOUS_REGEX);
  if (match && match[1] && match[2] && match[3]) {
    return {
      kind: 'anonymous_paren',
      frame: {
        function: '<anonymous>',
        filename: normalizeHermesStackFilename(match[1]),
        lineno: parseInt(match[2], 10),
        colno: parseInt(match[3], 10),
      },
    };
  }

  // Try native format: at functionName (native)
  match = trimmedLine.match(REACT_NATIVE_NATIVE_REGEX);
  if (match) {
    return {
      kind: 'native',
      frame: {
        function: match[1] || '<native>',
        filename: '<native>',
        isNative: true,
      },
    };
  }

  // Try release/minified format: functionName@123:456
  match = trimmedLine.match(REACT_NATIVE_RELEASE_REGEX);
  if (match && match[2] && match[3]) {
    return {
      kind: 'release_func_at',
      frame: {
        function: match[1] || '<anonymous>',
        filename: UNKNOWN_RELEASE_FILENAME,
        lineno: parseInt(match[2], 10),
        colno: parseInt(match[3], 10),
        releaseLine: true,
      },
    };
  }

  return { frame: null, kind: 'unparsed' };
}

/**
 * Parse a single stack trace line into a structured frame
 */
export function parseStackTraceLine(line: string): ParsedStackFrame | null {
  return parseStackTraceLineDetailed(line).frame;
}

/**
 * Parse a full stack trace string into an array of structured frames
 */
export function parseStackTrace(stackTrace: string): ParsedStackFrame[] {
  if (!stackTrace || typeof stackTrace !== 'string') {
    return [];
  }

  const lines = stackTrace.split('\n');
  const frames: ParsedStackFrame[] = [];

  for (const line of lines) {
    const { frame } = parseStackTraceLineDetailed(line);
    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

/**
 * Convert parsed stack frames to Faro's StackFrame format
 */
export function toFaroStackFrames(
  parsedFrames: ParsedStackFrame[],
  options?: StackFrameParseOptions
): StackFrame[] {
  const releaseName = options?.releaseBundleFilename ?? 'bundle.js';
  const keyedBasename =
    typeof options?.releaseBundleFilename === 'string' &&
    options.releaseBundleFilename.trim() !== ''
      ? options.releaseBundleFilename.trim()
      : null;

  return parsedFrames.map((frame, _index) => {
    let filename = normalizeHermesStackFilename(frame.filename || '<unknown>');
    if (frame.releaseLine) {
      filename = releaseName;
    } else if (keyedBasename) {
      filename = collapseBundledArtifactPath(filename, keyedBasename);
    }
    return {
      filename,
      function: frame.function || '<anonymous>',
      lineno: frame.lineno,
      colno: frame.colno,
    };
  });
}

/**
 * Extract and parse stack frames from an Error object
 */
export function getStackFramesFromError(error: Error, options?: StackFrameParseOptions): StackFrame[] {
  if (!error || !error.stack) {
    return [];
  }

  try {
    const parsedFrames = parseStackTrace(error.stack);
    return toFaroStackFrames(parsedFrames, options);
  } catch (_e) {
    // If parsing fails, return empty array
    return [];
  }
}

/**
 * Get platform-specific error context
 */
export function getPlatformErrorContext(): Record<string, string> {
  return {
    platform: Platform.OS,
    platformVersion: Platform.Version?.toString() || 'unknown',
    isHermes: typeof HermesInternal !== 'undefined' ? 'true' : 'false',
  };
}

/**
 * Enhance error with React Native specific information
 */
export function enhanceErrorWithContext(
  error: Error,
  additionalContext?: Record<string, string>,
  stackParseOptions?: StackFrameParseOptions
): {
  error: Error;
  stackFrames: StackFrame[];
  context: Record<string, string>;
} {
  const stackFrames = getStackFramesFromError(error, stackParseOptions);
  const platformContext = getPlatformErrorContext();

  return {
    error,
    stackFrames,
    context: {
      ...platformContext,
      ...additionalContext,
    },
  };
}
