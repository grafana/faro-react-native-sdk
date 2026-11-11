/**
 * PerformanceObserver compatibility patches for React Native.
 *
 * iOS: React Native 0.84's native PerformanceObserver has a bug on iOS that throws
 * `bad_variant_access` when the observer callback runs and calls getEntries().
 * This happens in NativePerformance.createObserver when the native bridge
 * returns data that causes a C++ variant access error.
 *
 * OpenTelemetry's FetchInstrumentation (and other libs) may use PerformanceObserver
 * for resource timing. We provide a no-op polyfill on React Native iOS to prevent
 * the crash while preserving refresh rate vitals and other functionality.
 *
 * @see https://github.com/facebook/react-native/issues (PerformanceObserver iOS)
 *
 * Other platforms (Android): React Native 0.83.0-0.83.4, 0.84.x and 0.85.0-0.85.2 append
 * resource timing entries to every registered native PerformanceObserver buffer from the
 * networking thread without a lock (`PerformanceObserver::handleEntry`), while the JS thread
 * swaps the same buffer in `PerformanceObserver::takeRecords`. Any JS observer of 'resource'
 * makes this race reachable, which corrupts the heap and aborts the app
 * (`Scudo ERROR: misaligned pointer when deallocating` in `NativePerformance::takeRecords`).
 * Fixed upstream in 0.83.5, 0.85.3 and 0.86. On 0.82 and older, resource timing is behind a
 * feature flag that is off by default.
 *
 * On those versions, and when the version cannot be determined, the global PerformanceObserver
 * is wrapped so that 'resource' is never registered natively, while other entry types keep
 * working. On web (react-native-web) the browser's PerformanceObserver is left untouched. Resource entries carry no data
 * Faro or OpenTelemetry can use on React Native (no `initiatorType`), so nothing is lost.
 */

import { Platform } from 'react-native';

const globalObj =
  (typeof globalThis !== 'undefined' && globalThis) ||
  (typeof global !== 'undefined' && global) ||
  (typeof window !== 'undefined' && window) ||
  {};

const RESOURCE_ENTRY_TYPE = 'resource';
const FARO_RESOURCE_TIMING_PATCH = '__faroResourceTimingPatch';
const FARO_RESOURCE_OBSERVER_GUARD = Symbol.for('grafana.faro.reactNative.resourceObserverGuard');

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
  durationThreshold?: number;
}

interface ReactNativeVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: unknown;
}

interface PerformanceObserverInstance {
  observe(options: PerformanceObserverInit): void;
  disconnect(): void;
  takeRecords(): PerformanceEntry[];
}

type PerformanceObserverConstructor = (new (callback: (...args: never[]) => void) => PerformanceObserverInstance) & {
  readonly supportedEntryTypes?: readonly string[];
};

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
 * instrumentation can probe it. On iOS the PerformanceObserver is replaced with a
 * no-op to avoid the native bad_variant_access crash. On other platforms running an
 * affected React Native version, 'resource' observation is stripped before it reaches
 * the native PerformanceObserver (see {@link isResourceObserverRaceAffected}). On web the
 * PerformanceObserver is left untouched.
 */
export function applyPerformanceObserverPolyfill(): void {
  const record = globalObj as Record<string, unknown>;
  patchUnsupportedResourceTimingLookup(record);

  if (Platform.OS === 'web') {
    // react-native-web uses the browser's PerformanceObserver, not React Native's native one.
    return;
  }

  if (Platform.OS !== 'ios') {
    if (isResourceObserverRaceAffected(readReactNativeVersion())) {
      guardResourcePerformanceObserver(record);
    }
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

/**
 * Whether resource observation must be kept away from the native PerformanceObserver for the
 * given `Platform.constants.reactNativeVersion` (`{ major, minor, patch, prerelease }`). Callers
 * skip this check on iOS (full no-op observer) and on web (no React Native native observer).
 *
 * - Affected stable versions: 0.83.0-0.83.4, 0.84.x (no fixed 0.84 release), 0.85.0-0.85.2.
 * - Prereleases (`prerelease` is a non-empty string) are compared by `major.minor.patch`, so
 *   `0.85.0-rc.1` is affected. A prerelease of a first fixed release (`0.83.5`, `0.85.3`,
 *   `0.86.0`) precedes that release and may not contain the fix yet, so it is affected too.
 *   Prereleases of 0.82 and older, of 0.86.1+ and of later minors/majors are not.
 * - `0.0.0` prereleases (nightlies) do not identify their source revision, so they are affected.
 * - Missing, unreadable or malformed metadata is affected (fail closed): non-integer or negative
 *   parts, missing parts, or a `prerelease` that is neither a string nor null/undefined (React
 *   Native types it as `string | null`). Missing an affected version aborts the app with
 *   uncatchable heap corruption, while guarding an unaffected one only drops resource entries
 *   that OpenTelemetry discards on React Native anyway.
 */
export function isResourceObserverRaceAffected(version: unknown): boolean {
  if (!isValidReactNativeVersion(version)) {
    return true;
  }

  const { major, minor, patch, prerelease } = version;
  if (prerelease != null && typeof prerelease !== 'string') {
    return true;
  }

  if (major !== 0) {
    return false;
  }

  const isPrerelease = typeof prerelease === 'string' && prerelease !== '';

  switch (minor) {
    case 0:
      return isPrerelease && patch === 0;
    case 83:
      return patch <= 4 || (isPrerelease && patch === 5);
    case 84:
      return true;
    case 85:
      return patch <= 2 || (isPrerelease && patch === 3);
    case 86:
      return isPrerelease && patch === 0;
    default:
      return false;
  }
}

function isValidReactNativeVersion(version: unknown): version is ReactNativeVersion {
  if (!version || typeof version !== 'object') {
    return false;
  }

  const { major, minor, patch } = version as Record<string, unknown>;
  return [major, minor, patch].every((part) => typeof part === 'number' && Number.isInteger(part) && part >= 0);
}

function readReactNativeVersion(): unknown {
  try {
    return (Platform as { constants?: { reactNativeVersion?: unknown } }).constants?.reactNativeVersion;
  } catch {
    // An unreadable version is treated as affected by isResourceObserverRaceAffected.
    return undefined;
  }
}

type NativeObserveOptions = { skip: true } | { skip: false; options: PerformanceObserverInit };

function withoutResourceEntryType(options: PerformanceObserverInit): NativeObserveOptions {
  if (!options || typeof options !== 'object') {
    // Let the native implementation report invalid arguments.
    return { skip: false, options };
  }

  // Shapes that native rejects (`type` together with `entryTypes`, or `entryTypes` together with
  // `durationThreshold`) are always forwarded so native throws its own TypeError. Native validates
  // before it registers anything, and it reads `entryTypes` before `type`, so 'resource' is still
  // removed from `entryTypes` (keeping the array, even when empty) as a second line of defense.
  // Valid calls that only ask for 'resource' are dropped without native mode validation
  // (single-type vs. entryTypes mixing), which is more permissive than native.
  if (Array.isArray(options.entryTypes)) {
    if (!options.entryTypes.includes(RESOURCE_ENTRY_TYPE)) {
      return { skip: false, options };
    }

    const entryTypes = options.entryTypes.filter((entryType) => entryType !== RESOURCE_ENTRY_TYPE);
    const nativeRejects = Boolean(options.type) || options.durationThreshold != null;

    return entryTypes.length > 0 || nativeRejects
      ? { skip: false, options: { ...options, entryTypes } }
      : { skip: true };
  }

  return options.type === RESOURCE_ENTRY_TYPE ? { skip: true } : { skip: false, options };
}

/**
 * Create a subclass of the native PerformanceObserver that never registers 'resource'
 * natively. Subclassing keeps `instanceof` checks against both classes working, keeps
 * `typeof PerformanceObserver === 'function'`, and makes the native implementation pass
 * the wrapper instance to the user callback. The native class only creates its native
 * observer on the first `observe()` it receives, so an observer that only asks for
 * 'resource' never touches native code, and `takeRecords()`/`disconnect()` stay safe.
 */
function createResourceSafePerformanceObserver(
  NativePerformanceObserver: PerformanceObserverConstructor
): PerformanceObserverConstructor {
  const nativeSupported = NativePerformanceObserver.supportedEntryTypes;
  const supportedEntryTypes: readonly string[] = Object.freeze(
    Array.isArray(nativeSupported) ? nativeSupported.filter((entryType) => entryType !== RESOURCE_ENTRY_TYPE) : []
  );

  class ResourceSafePerformanceObserver extends NativePerformanceObserver {
    static override get supportedEntryTypes(): readonly string[] {
      return supportedEntryTypes;
    }

    override observe(options: PerformanceObserverInit): void {
      const result = withoutResourceEntryType(options);
      if (result.skip) {
        return;
      }

      super.observe(result.options);
    }
  }

  Object.defineProperty(ResourceSafePerformanceObserver, FARO_RESOURCE_OBSERVER_GUARD, { value: true });
  Object.defineProperty(ResourceSafePerformanceObserver, 'name', { value: NativePerformanceObserver.name });

  return ResourceSafePerformanceObserver;
}

function guardResourcePerformanceObserver(record: Record<string, unknown>): void {
  const existing = record['PerformanceObserver'];
  if (typeof existing !== 'function') {
    return;
  }

  // Normal (inherited) lookup: a subclass of the wrapper, or a wrapper created by another copy
  // of this package, is not wrapped again.
  if ((existing as unknown as Record<symbol, unknown>)[FARO_RESOURCE_OBSERVER_GUARD] === true) {
    return; // Already applied
  }

  try {
    // Wrapper creation is inside the try: extending a callable that is not a constructor, or
    // reading a throwing static, must not break the import of the SDK.
    record['PerformanceObserver'] = createResourceSafePerformanceObserver(existing as PerformanceObserverConstructor);
  } catch {
    // Ignore if the global is frozen or cannot be subclassed
  }
}
