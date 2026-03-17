/**
 * PerformanceObserver polyfill for React Native iOS
 *
 * React Native 0.84's native PerformanceObserver has a bug on iOS that throws
 * `bad_variant_access` when the observer callback runs and calls getEntries().
 * This happens in NativePerformance.createObserver when the native bridge
 * returns data that causes a C++ variant access error.
 *
 * OpenTelemetry's FetchInstrumentation (and other libs) may use PerformanceObserver
 * for resource timing. We provide a no-op polyfill on React Native iOS to prevent
 * the crash while preserving refresh rate vitals and other functionality.
 *
 * @see https://github.com/facebook/react-native/issues (PerformanceObserver iOS)
 */

import { Platform } from 'react-native';

const globalObj =
  (typeof globalThis !== 'undefined' && globalThis) ||
  (typeof global !== 'undefined' && global) ||
  (typeof window !== 'undefined' && window) ||
  {};

interface PerformanceEntry {
  readonly duration: number;
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
}

interface PerformanceObserverEntryList {
  getEntries(): PerformanceEntry[];
  getEntriesByName(name: string, type?: string): PerformanceEntry[];
  getEntriesByType(type: string): PerformanceEntry[];
}

interface PerformanceObserverInit {
  entryTypes?: string[];
  type?: string;
  buffered?: boolean;
}

/**
 * No-op PerformanceObserver that matches the Web API interface.
 * Prevents crashes when React Native's native implementation throws.
 */
class NoopPerformanceObserver {
  constructor(
    _callback: (
      list: PerformanceObserverEntryList,
      observer: NoopPerformanceObserver,
      options?: PerformanceObserverInit
    ) => void
  ) {
    // Callback is never invoked - avoids triggering the native bug
  }

  observe(_options?: PerformanceObserverInit): void {
    // No-op
  }

  disconnect(): void {
    // No-op
  }

  takeRecords(): PerformanceEntry[] {
    return [];
  }

  static readonly supportedEntryTypes: string[] = [];
}

/**
 * Apply polyfill on React Native iOS to prevent bad_variant_access crash.
 * Must run before any code that might use PerformanceObserver.
 */
export function applyPerformanceObserverPolyfill(): void {
  if (Platform.OS !== 'ios') {
    return;
  }

  const record = globalObj as Record<string, unknown>;
  const existing = record['PerformanceObserver'];
  if (existing && (existing as unknown as { name?: string }).name === 'NoopPerformanceObserver') {
    return; // Already applied
  }

  try {
    record['PerformanceObserver'] = NoopPerformanceObserver;
  } catch {
    // Ignore if global is frozen (e.g. in some test environments)
  }
}
