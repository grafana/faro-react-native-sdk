import { FARO_COLLECTOR_URL } from '@env';
import { InternalLoggerLevel, Config } from '@grafana/faro-core';

import {
  ConsoleTransport,
  FetchTransport,
  getRNInstrumentations,
  initializeFaro,
  LogLevel,
  OfflineTransport,
} from '@grafana/faro-react-native';
import type { ReactNativeConfig } from '@grafana/faro-react-native';
import { TracingInstrumentation } from '@grafana/faro-react-native-tracing';

/** In dev, use VERBOSE internal logger to diagnose collector connectivity issues */
const FARO_DEBUG = __DEV__;

/**
 * Demo versions to simulate different app releases
 */
const DEMO_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0'];

/**
 * Get a random version for demo purposes
 */
function getDemoVersion(): string {
  const randomIndex = Math.floor(Math.random() * DEMO_VERSIONS.length);
  return DEMO_VERSIONS[randomIndex];
}

/**
 * Initialize Faro for React Native demo app with Grafana Cloud.
 * Aligned with mobile-o11y-demo (Flutter) and faro-flutter-sdk example config:
 * - OfflineTransport (3 days cache)
 * - CPU/memory vitals, ANR, crash reporting, frame metrics
 * - fetchVitalsInterval: 30 seconds
 */
export function initFaro() {
  if (!FARO_COLLECTOR_URL) {
    console.warn('FARO_COLLECTOR_URL not configured. Faro will not be initialized.');
    return undefined;
  }

  // Get random version for demo
  const appVersion = getDemoVersion();

  const fetchVitalsInterval = FARO_DEBUG ? 5000 : 30000;

  // Faro config - single source of truth, aligned with Flutter SDK FaroConfig.
  // getRNInstrumentations reads all options from this config.
  const config: Partial<ReactNativeConfig> = {
    app: {
      name: 'react-native-sdk-demo',
      version: appVersion,
      environment: 'production',
    },

    // Performance vitals (aligned with Flutter SDK)
    cpuUsageVitals: true,
    memoryUsageVitals: true,
    refreshRateVitals: true,
    fetchVitalsInterval,

    // Error & crash tracking (aligned with Flutter SDK)
    enableErrorReporting: true,
    enableCrashReporting: true,
    anrTracking: true,

    // Helps diagnose collector issues: see transport activity in Metro console
    internalLoggerLevel: FARO_DEBUG ? InternalLoggerLevel.VERBOSE : InternalLoggerLevel.ERROR,

    transports: [
      new OfflineTransport({
        maxCacheDurationMs: 3 * 24 * 60 * 60 * 1000, // 3 days (matches Flutter)
      }),
      new FetchTransport({
        url: FARO_COLLECTOR_URL,
      }),
      // new ConsoleTransport({
      //   level: LogLevel.INFO,
      // }),
    ],
  };

  // Add instrumentations based on config (reads all options from config)
  config.instrumentations = [
    ...getRNInstrumentations(config),
    new TracingInstrumentation({}),
  ];

  const faro = initializeFaro(config as ReactNativeConfig);

  faro.api.pushEvent('faro_initialized', { timestamp: new Date().toISOString()});

  return faro;
}
