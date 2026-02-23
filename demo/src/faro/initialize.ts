import { FARO_COLLECTOR_URL } from '@env';
import { InternalLoggerLevel } from '@grafana/faro-core';

import { initializeFaro } from '@grafana/faro-react-native';
import type { ReactNativeConfig } from '@grafana/faro-react-native';

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
 * Flag-based config: enable what you need, makeRNConfig builds the rest.
 * Aligned with mobile-o11y-demo (Flutter) and faro-flutter-sdk example.
 */
export function initFaro() {
  console.log('[FARO DEBUG] Starting Faro initialization');
  console.log('[FARO DEBUG] FARO_COLLECTOR_URL:', FARO_COLLECTOR_URL);

  if (!FARO_COLLECTOR_URL) {
    console.warn('FARO_COLLECTOR_URL not configured. Faro will not be initialized.');
    return undefined;
  }

  const appVersion = getDemoVersion();
  const fetchVitalsInterval = FARO_DEBUG ? 5000 : 30000;

  const config: ReactNativeConfig = {
    app: {
      name: 'react-native-sdk-demo',
      version: appVersion,
      environment: 'production',
    },

    url: FARO_COLLECTOR_URL,

    // Performance vitals (aligned with Flutter SDK)
    cpuUsageVitals: true,
    memoryUsageVitals: true,
    refreshRateVitals: true,
    fetchVitalsInterval,

    // Error & crash tracking (aligned with Flutter SDK)
    enableErrorReporting: true,
    enableCrashReporting: true,
    anrTracking: true,

    // Console capture
    enableConsoleCapture: true,

    // Internal logger
    internalLoggerLevel: FARO_DEBUG ? InternalLoggerLevel.VERBOSE : InternalLoggerLevel.ERROR,

    // Transports: enable what to use
    enableTransports: {
      offline: true,
      fetch: true,
      console: FARO_DEBUG,
    },

    // OpenTelemetry tracing (requires @grafana/faro-react-native-tracing)
    enableTracing: true,
  };

  const faro = initializeFaro(config);

  faro.api.pushEvent('faro_initialized', {
    timestamp: new Date().toISOString(),
  });

  return faro;
}
