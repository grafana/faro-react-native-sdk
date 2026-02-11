import type { Config } from '@grafana/faro-core';

import type { ANRInstrumentationOptions } from '../instrumentations/anr';
import type { FrameMonitoringOptions } from '../instrumentations/frameMonitoring';

/**
 * React Native-specific configuration options
 *
 * Aligned with Faro Flutter SDK FaroConfig: All options are in the main config.
 * Access any option via faro.config (e.g., faro.config.cpuUsageVitals).
 */
export interface ReactNativeConfig extends Omit<Config, 'metas'> {
  /**
   * Optional metas to include. If not provided, default RN metas will be used
   */
  metas?: Config['metas'];

  // ============================================================================
  // Performance Vitals (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Enable CPU usage monitoring (default: true)
   * Monitors CPU usage percentage via differential calculation.
   * Uses native OS APIs - no manual setup required!
   * Requires: iOS 13.4+, Android API 21+
   */
  cpuUsageVitals?: boolean;

  /**
   * Enable memory usage monitoring (default: true)
   * Monitors RSS (Resident Set Size) - physical memory used by the app.
   * Uses native OS APIs - no manual setup required!
   * Requires: iOS 13.4+, Android any version
   */
  memoryUsageVitals?: boolean;

  /**
   * Enable refresh rate monitoring (default: false)
   * Monitors display refresh rate in FPS.
   */
  refreshRateVitals?: boolean;

  /**
   * Interval (in milliseconds) for collecting performance vitals (default: 30000 - 30 seconds)
   * Controls how often CPU and memory metrics are collected and sent.
   * Minimum recommended: 5000ms (5 seconds) to avoid overhead.
   *
   * Note: Flutter SDK uses Duration type; React Native uses milliseconds for consistency with JS APIs.
   */
  fetchVitalsInterval?: number;

  /**
   * Advanced configuration options for frame monitoring (React Native-specific).
   * Only used when refreshRateVitals is true.
   * Flutter SDK uses hardcoded values; these options allow customization if needed.
   */
  frameMonitoringOptions?: FrameMonitoringOptions;

  // ============================================================================
  // Error & Crash Tracking (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Enable JavaScript error and exception capture (default: true)
   * Equivalent to Flutter SDK's enableFlutterErrorReporting.
   */
  enableErrorReporting?: boolean;

  /**
   * Enable crash reporting (default: false)
   * Retrieves crash reports from previous app sessions.
   * Android: Uses ApplicationExitInfo API (Android 11+)
   * iOS: Requires PLCrashReporter dependency (experimental)
   */
  enableCrashReporting?: boolean;

  /**
   * Enable ANR (Application Not Responding) detection (default: false)
   * Detects when the main thread is blocked for extended periods.
   * Only available on Android.
   */
  anrTracking?: boolean;

  /**
   * Configuration options for ANR detection.
   * Only used when anrTracking is true.
   */
  anrOptions?: ANRInstrumentationOptions;

  // ============================================================================
  // Network (aligned with Flutter SDK)
  // ============================================================================

  /**
   * URLs to ignore for HTTP tracking (regex patterns)
   * Aligned with Flutter SDK ignoreUrls.
   */
  ignoreUrls?: RegExp[];

  // ============================================================================
  // User Persistence (aligned with Flutter SDK)
  // ============================================================================

  /**
   * Whether to persist user data between app sessions (default: true)
   * When enabled, the user set via faro.api.setUser() will be
   * automatically restored on the next app start.
   */
  persistUser?: boolean;
}

/**
 * @deprecated Use ReactNativeConfig directly. All options are now in the main Faro config.
 * This type alias is kept for backward compatibility.
 */
export type GetRNInstrumentationsOptions = Partial<ReactNativeConfig>;
