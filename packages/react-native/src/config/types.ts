import type { Config } from '@grafana/faro-core';

import type { ANRInstrumentationOptions } from '../instrumentations/anr';
import type { FrameMonitoringOptions } from '../instrumentations/frameMonitoring';

/** Extends faro-core session tracking with RN-specific timeout options (both in ms). */
export type ReactNativeSessionTrackingConfig = Config['sessionTracking'] & {
  /** Inactivity before session invalid (default: 15 min). */
  inactivityTimeout?: number;
  /** Max session lifetime from start (default: 4 h). */
  sessionExpirationTime?: number;
};

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

/** RN-specific config: overrides + new props. Omit faro-core props we replace with RN equivalents. */
type ReactNativeConfigOverrides = {
  /** Application metadata (required) */
  app: Config['app'];
  sessionTracking?: ReactNativeSessionTrackingConfig;
  url?: string;
  apiKey?: string;
  enableTransports?: EnableTransportsConfig;
  enableTracing?: boolean;
  /** Passed to TracingInstrumentation. See TracingInstrumentationOptions in @grafana/faro-react-native-tracing. */
  tracingOptions?: Record<string, unknown>;
  cpuUsageVitals?: boolean;
  memoryUsageVitals?: boolean;
  refreshRateVitals?: boolean;
  fetchVitalsInterval?: number;
  frameMonitoringOptions?: FrameMonitoringOptions;
  enableErrorReporting?: boolean;
  enableCrashReporting?: boolean;
  anrTracking?: boolean;
  anrOptions?: ANRInstrumentationOptions;
  enableConsoleCapture?: boolean;
  consoleCaptureOptions?: Config['consoleInstrumentation'];
  enableUserActions?: boolean;
  userActionsOptions?: Config['userActionsInstrumentation'];
  persistUser?: boolean;
};

/**
 * React Native config: Config (omit replaced props) & overrides.
 * Omit: sessionTracking, consoleInstrumentation, userActionsInstrumentation.
 * instrumentations and transports inherited from Config for extras (built-ins come from flags).
 */
export type ReactNativeConfig = Partial<
  Omit<Config, 'sessionTracking' | 'consoleInstrumentation' | 'userActionsInstrumentation'>
> &
  ReactNativeConfigOverrides;
