import type { Instrumentation } from '@grafana/faro-core';
import { Platform } from 'react-native';

import { ANRInstrumentation } from '../instrumentations/anr';
import { AppStateInstrumentation } from '../instrumentations/appState';
import { ConsoleInstrumentation } from '../instrumentations/console';
import { CrashReportingInstrumentation } from '../instrumentations/crashReporting';
import { ErrorsInstrumentation } from '../instrumentations/errors';
import { FrameMonitoringInstrumentation } from '../instrumentations/frameMonitoring';
import { HttpInstrumentation } from '../instrumentations/http';
import { PerformanceInstrumentation } from '../instrumentations/performance';
import { SessionInstrumentation } from '../instrumentations/session';
import { StartupInstrumentation } from '../instrumentations/startup';
import { UserActionInstrumentation } from '../instrumentations/userActions';
import { ViewInstrumentation } from '../instrumentations/view';

import type { ReactNativeConfig } from './types';

/**
 * Returns the default set of instrumentations for React Native.
 *
 * Reads all options from the Faro config (single source of truth).
 * Property names are aligned with Flutter SDK FaroConfig:
 * - cpuUsageVitals, memoryUsageVitals, anrTracking, refreshRateVitals
 * - enableCrashReporting, enableErrorReporting
 * - fetchVitalsInterval, ignoreUrls
 *
 * @example
 * ```ts
 * const config: ReactNativeConfig = {
 *   app: { name: 'my-app', version: '1.0.0' },
 *   cpuUsageVitals: true,
 *   memoryUsageVitals: true,
 *   anrTracking: true,
 *   refreshRateVitals: true,
 *   enableCrashReporting: true,
 *   fetchVitalsInterval: 30000,
 *   instrumentations: getRNInstrumentations(config),
 * };
 * ```
 */
export function getRNInstrumentations(config: Partial<ReactNativeConfig> = {}): Instrumentation[] {
  // Aligned with Flutter SDK FaroConfig defaults
  const {
    // Error & crash tracking
    enableErrorReporting = true,
    enableCrashReporting = false,
    anrTracking = false,
    anrOptions = {},

    // Performance vitals
    cpuUsageVitals = true,
    memoryUsageVitals = true,
    refreshRateVitals = false,
    fetchVitalsInterval = 30000,
    frameMonitoringOptions = {},

    // Network
    ignoreUrls = [],
  } = config;

  const instrumentations: Instrumentation[] = [];

  // Error reporting (Flutter: enableFlutterErrorReporting)
  if (enableErrorReporting) {
    instrumentations.push(new ErrorsInstrumentation());
  }

  // Console capture - not in Flutter SDK, RN-specific
  // Default: false (opt-in)
  instrumentations.push(new ConsoleInstrumentation());

  // Sessions - always enabled in Flutter, same here
  instrumentations.push(new SessionInstrumentation());

  // Views - always enabled in Flutter, same here
  instrumentations.push(new ViewInstrumentation());

  // App state - always enabled in Flutter, same here
  instrumentations.push(new AppStateInstrumentation());

  // User actions - always enabled in Flutter, same here
  instrumentations.push(new UserActionInstrumentation());

  // HTTP tracking - always enabled in Flutter (via HttpOverrides), same here
  instrumentations.push(new HttpInstrumentation({ ignoredUrls: ignoreUrls }));

  // Performance vitals (CPU/memory)
  const perfInstrumentation = new PerformanceInstrumentation({
    memoryUsageVitals,
    cpuUsageVitals,
    fetchVitalsInterval,
  });
  instrumentations.push(perfInstrumentation);

  // Startup tracking - always enabled
  instrumentations.push(new StartupInstrumentation());

  // Frame monitoring: enabled when refreshRateVitals is true
  // The instrumentation reads refreshRateVitals from faro.config (single source of truth)
  if (refreshRateVitals) {
    instrumentations.push(new FrameMonitoringInstrumentation(frameMonitoringOptions));
  }

  // ANR detection (Android only)
  if (anrTracking && Platform.OS === 'android') {
    instrumentations.push(new ANRInstrumentation(anrOptions));
  }

  // Crash reporting
  if (enableCrashReporting) {
    instrumentations.push(new CrashReportingInstrumentation());
  }

  return instrumentations;
}
