import type { Config } from '@grafana/faro-core';

import type { ANRInstrumentationOptions } from '../instrumentations/anr';
import type { FrameMonitoringOptions } from '../instrumentations/frameMonitoring';
import type { Sampling } from './sampling';

/**
 * React Native session tracking config.
 * Extends Config['sessionTracking'] with sampling (Flutter-style) and RN-specific props.
 * Excludes samplingRate and sampler in favor of sampling.
 */
export type ReactNativeSessionTrackingConfig = Omit<
  NonNullable<Config['sessionTracking']>,
  'samplingRate' | 'sampler'
> & {
  /**
   * Session sampling. Use {@link SamplingRate} for fixed rate or
   * {@link SamplingFunction} for dynamic sampling.
   */
  sampling?: Sampling;
};

/**
 * Flags for enabling optional built-in transports.
 * FetchTransport is always instantiated when url is provided.
 */
export interface EnableTransportsConfig {
  /** Enable OfflineTransport for caching when offline (default: false) */
  offline?: boolean;
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
  /**
   * Which HTTP instrumentations to enable. When tracing is disabled, these control
   * HttpInstrumentation (fetch) and XHRInstrumentation (xhr). Default: both true.
   */
  enableHttpInstrumentation?: {
    /** HttpInstrumentation - patches fetch API (default: true) */
    fetch?: boolean;
    /** XHRInstrumentation - patches XMLHttpRequest (default: true) */
    xhr?: boolean;
  };
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
