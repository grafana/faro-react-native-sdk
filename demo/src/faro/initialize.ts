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
  console.log('[FARO DEBUG] Starting Faro initialization...');
  console.log('[FARO DEBUG] FARO_COLLECTOR_URL value:', FARO_COLLECTOR_URL);
  console.log(
    '[FARO DEBUG] FARO_COLLECTOR_URL type:',
    typeof FARO_COLLECTOR_URL,
  );

  if (!FARO_COLLECTOR_URL) {
    console.warn(
      'FARO_COLLECTOR_URL not configured. Faro will not be initialized.',
    );
    return undefined;
  }

  // Validate collector URL format (common typo: missing 'h' in https)
  if (!FARO_COLLECTOR_URL.startsWith('https://')) {
    console.error(
      '[FARO] Invalid FARO_COLLECTOR_URL: must start with https://. Got:',
      FARO_COLLECTOR_URL.substring(0, 20) + '...',
    );
    return undefined;
  }

  // Get random version for demo
  const appVersion = getDemoVersion();
  console.log(`[FARO DEBUG] App version: ${appVersion}`);

  console.log('[FARO DEBUG] Creating instrumentations...');

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

  faro.api.pushEvent('faro_initialized', {
    timestamp: new Date().toISOString(),
  });

  // Run collector connectivity test (helps diagnose "no data arriving" issues)
  if (FARO_DEBUG) {
    testCollectorConnectivity(FARO_COLLECTOR_URL);
  }

  return faro;
}

/**
 * Sends a minimal test payload to the collector and logs the result.
 * Run this when FARO_DEBUG is true to diagnose connectivity issues.
 */
async function testCollectorConnectivity(collectorUrl: string): Promise<void> {
  console.log('[FARO DIAG] Starting network diagnostics...');

  // Test 1: Can we reach the internet at all?
  console.log('[FARO DIAG] Test 1: Checking general internet connectivity...');
  try {
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), 5000);

    const googleResponse = await fetch('https://httpbin.org/get', {
      method: 'GET',
      signal: controller1.signal,
    });
    clearTimeout(timeout1);
    console.log('[FARO DIAG] ✅ Internet connectivity OK - httpbin.org returned:', googleResponse.status);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[FARO DIAG] ❌ Internet connectivity FAILED:', errorMessage);
    console.error('[FARO DIAG] This suggests the emulator cannot reach the internet.');
    return; // No point testing collector if internet is down
  }

  // Test 2: Can we reach the collector host?
  console.log('[FARO DIAG] Test 2: Checking collector connectivity...');
  const testPayload = {
    meta: {
      app: { name: 'react-native-sdk-demo', version: '1.0.0' },
      sdk: { name: '@grafana/faro-react-native', version: '1.0.0' },
    },
    measurements: [
      {
        type: 'test_measurement',
        values: { test: 1 },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => {
      controller2.abort();
      console.error('[FARO DIAG] ❌ Collector request TIMED OUT after 10s');
    }, 10000);

    const response = await fetch(collectorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Faro-Session-Id': 'diag-test-session',
      },
      body: JSON.stringify(testPayload),
      signal: controller2.signal,
    });
    clearTimeout(timeout2);

    const status = response.status;

    if (status === 202) {
      console.log('[FARO DIAG] ✅ Collector connectivity OK - received 202 Accepted');
    } else if (status === 400) {
      const text = await response.text().catch(() => '');
      console.warn('[FARO DIAG] ⚠️ Collector returned 400:', text);
    } else {
      console.warn('[FARO DIAG] ⚠️ Collector returned:', status, response.statusText);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[FARO DIAG] ❌ Collector connectivity FAILED:', errorMessage);
    if (errorMessage.includes('Aborted')) {
      console.error('[FARO DIAG] Request was aborted (likely timeout)');
    }
  }

  console.log('[FARO DIAG] Network diagnostics complete.');
}
