import type { Config } from '@grafana/faro-core';

import type { ANRInstrumentationOptions } from '../instrumentations/anr';
import type { FrameMonitoringOptions } from '../instrumentations/frameMonitoring';
import type { TracingInstrumentationOptions } from '@grafana/faro-react-native-tracing';

/**
 * Flags for enabling built-in transports.
 * When provided, makeRNConfig builds transports from these flags instead of requiring manual transport setup.
 * Requires `url` when fetch is true.
 */
export interface EnableTransportsConfig {
  /** Enable OfflineTransport for caching when offline (default: false) */
  offline?: boolean;
  /** Enable FetchTransport to send to collector (default: true when url is provided) */
  fetch?: boolean;
  /** Enable ConsoleTransport to log telemetry to Metro console for debugging (default: false) */
  console?: boolean;
}

/**
 * React Native-specific configuration options
 *
 * Flag-based config: Set what to enable, makeRNConfig builds instrumentations and transports.
 * Only `app` is required; faro-core props (dedupe, parseStacktrace, etc.) have defaults in makeRNConfig.
 */
export interface ReactNativeConfig
  extends Partial<Omit<Config, 'app' | 'metas' | 'instrumentations' | 'transports'>> {
  /** Application metadata (required) */
  app: Config['app'];

  /**
   * Optional metas to include. If not provided, default RN metas will be used
   */
  metas?: Config['metas'];

  /**
   * Collector URL for FetchTransport. Required when enableTransports.fetch is true.
   * Also used to filter collector URLs from HTTP instrumentation.
   */
  url?: string;

  /**
   * API key for collector authentication. Added as x-api-key header.
   */
  apiKey?: string;

  /**
   * Enable built-in transports by flag. Built transports are OfflineTransport, FetchTransport, ConsoleTransport.
   * Custom transports from the transports array are appended after the built-in set.
   */
  enableTransports?: EnableTransportsConfig;

  /**
   * Enable OpenTelemetry tracing. Requires @grafana/faro-react-native-tracing.
   * When true, TracingInstrumentation is added to instrumentations.
   */
  enableTracing?: boolean;

  /**
   * Options for TracingInstrumentation. Only used when enableTracing is true.
   * Same type as TracingInstrumentation constructor from @grafana/faro-react-native-tracing.
   */
  tracingOptions?: TracingInstrumentationOptions;

  /**
   * Additional custom transports appended to the built-in set from enableTransports.
   * Same pattern as instrumentations: built-ins first, then extras.
   * To use only custom transports, set enableTransports: { offline: false, fetch: false, console: false }.
   */
  transports?: Config['transports'];

  /**
   * Additional instrumentations to add after the default set.
   * Default instrumentations are built from flags; this allows adding extras (e.g. custom instrumentations).
   */
  instrumentations?: Config['instrumentations'];

  // ============================================================================
  // Performance Vitals (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Enable CPU usage monitoring (default: true)
   */
  cpuUsageVitals?: boolean;

  /**
   * Enable memory usage monitoring (default: true)
   */
  memoryUsageVitals?: boolean;

  /**
   * Enable refresh rate monitoring (default: false)
   */
  refreshRateVitals?: boolean;

  /**
   * Interval (ms) for collecting performance vitals (default: 30000)
   */
  fetchVitalsInterval?: number;

  /**
   * Options for frame monitoring. Only used when refreshRateVitals is true.
   */
  frameMonitoringOptions?: FrameMonitoringOptions;

  // ============================================================================
  // Error & Crash Tracking (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Enable JavaScript error capture (default: true)
   */
  enableErrorReporting?: boolean;

  /**
   * Enable crash reporting (default: false)
   */
  enableCrashReporting?: boolean;

  /**
   * Enable ANR detection (default: false, Android only)
   */
  anrTracking?: boolean;

  /**
   * Options for ANR detection. Only used when anrTracking is true.
   */
  anrOptions?: ANRInstrumentationOptions;

  /**
   * Enable console log capture via ConsoleInstrumentation (default: true)
   */
  enableConsoleCapture?: boolean;

  /**
   * Options for ConsoleInstrumentation when enableConsoleCapture is true
   */
  consoleCaptureOptions?: Config['consoleInstrumentation'];

  /**
   * Enable user action tracking via UserActionInstrumentation (default: true)
   * Tracks interactions from withFaroUserAction HOC and trackUserAction helper.
   */
  enableUserActions?: boolean;

  /**
   * Options for UserActionInstrumentation when enableUserActions is true
   */
  userActionsOptions?: Config['userActionsInstrumentation'];

  // ============================================================================
  // Network (aligned with Flutter SDK)
  // ============================================================================

  /**
   * URLs to ignore for HTTP tracking (regex patterns)
   */
  ignoreUrls?: RegExp[];

  /**
   * Error message patterns to ignore (faro-core ignoreErrors)
   */
  ignoreErrors?: Config['ignoreErrors'];

  /**
   * Hook to modify/filter events before sending (faro-core beforeSend)
   */
  beforeSend?: Config['beforeSend'];

  /**
   * Preserve original Error in transport items for beforeSend (faro-core preserveOriginalError)
   */
  preserveOriginalError?: Config['preserveOriginalError'];

  // ============================================================================
  // User Persistence (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Whether to persist user data between app sessions (default: true)
   */
  persistUser?: boolean;
}
