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

const RESOURCE_ENTRY_TYPE = 'resource';
const FARO_RESOURCE_TIMING_PATCH = '__faroResourceTimingPatch';

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
 * Apply React Native performance API compatibility patches.
 *
 * Resource Timing lookup is patched on all platforms because OTel web
 * instrumentation can probe it. The PerformanceObserver replacement is
 * iOS-only to avoid the native bad_variant_access crash.
 */
export function applyPerformanceObserverPolyfill(): void {
  const record = globalObj as Record<string, unknown>;
  patchUnsupportedResourceTimingLookup(record);

  if (Platform.OS !== 'ios') {
    return;
  }

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

function patchUnsupportedResourceTimingLookup(record: Record<string, unknown>): void {
  const performance = record['performance'] as
    | {
        getEntriesByType?: ((entryType: string) => PerformanceEntry[]) & Record<string, boolean>;
      }
    | undefined;

  if (!performance?.getEntriesByType || performance.getEntriesByType[FARO_RESOURCE_TIMING_PATCH]) {
    return;
  }

  const originalGetEntriesByType = performance.getEntriesByType.bind(performance);
  const patchedGetEntriesByType = ((entryType: string): PerformanceEntry[] => {
    if (entryType === RESOURCE_ENTRY_TYPE) {
      // OTel web fetch instrumentation probes browser Resource Timing APIs.
      // React Native does not expose resource entries, and calling through emits
      // "Deprecated API for given entry type." warnings in development.
      return [];
    }

    return originalGetEntriesByType(entryType);
  }) as typeof performance.getEntriesByType;

  patchedGetEntriesByType[FARO_RESOURCE_TIMING_PATCH] = true;

  try {
    performance.getEntriesByType = patchedGetEntriesByType;
  } catch {
    // Ignore if performance is read-only in a test or host environment.
  }
}
