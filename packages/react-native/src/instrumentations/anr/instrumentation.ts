import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import { NativeModules, Platform } from 'react-native';

import type { ANREvent, ANRInstrumentationOptions } from './types';

/**
 * Default timeout for ANR detection (5 seconds, matching Android's threshold)
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * Default polling interval for ANR status (60 seconds, matching Flutter SDK)
 */
const DEFAULT_POLLING_INTERVAL = 60000;

/**
 * ANR (Application Not Responding) Detection Instrumentation.
 *
 * Detects when the main/UI thread is blocked for extended periods on Android.
 * Uses a background thread that posts tasks to the main thread and monitors
 * if they complete within the timeout.
 *
 * **Note**: ANR detection is only available on Android. iOS does not have
 * the same ANR concept as Android's system watchdog.
 *
 * Sends telemetry via Faro API:
 * - Measurement: `anr` with `anr_count` value
 * - Error: Each ANR with its stack trace
 *
 * @example
 * ```typescript
 * import { initializeFaro, ANRInstrumentation } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   url: 'https://collector.example.com',
 *   instrumentations: [
 *     new ANRInstrumentation({
 *       timeout: 5000,        // 5 second threshold
 *       pollingInterval: 60000, // Poll every 60 seconds
 *     }),
 *   ],
 * });
 * ```
 */
export class ANRInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-anr';
  readonly version = VERSION;

  private readonly options: Required<ANRInstrumentationOptions>;
  private pollingIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: ANRInstrumentationOptions = {}) {
    super();
    this.options = {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      pollingInterval: options.pollingInterval ?? DEFAULT_POLLING_INTERVAL,
    };
  }

  initialize(): void {
    // ANR detection is only available on Android
    if (Platform.OS !== 'android') {
      this.logDebug('ANR detection is only available on Android');
      return;
    }

    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      this.logWarn('Native module not available for ANR detection');
      return;
    }

    this.logDebug('Initializing ANR detection instrumentation');

    // Start native ANR tracking
    this.startNativeTracking(nativeModule);

    // Set up polling for ANR status
    this.pollingIntervalId = setInterval(() => {
      this.checkANRStatus(nativeModule);
    }, this.options.pollingInterval);
  }

  private getNativeModule(): typeof NativeModules.FaroReactNativeModule | null {
    const { FaroReactNativeModule } = NativeModules;

    if (!FaroReactNativeModule) {
      return null;
    }

    return FaroReactNativeModule;
  }

  private startNativeTracking(nativeModule: typeof NativeModules.FaroReactNativeModule): void {
    try {
      if (typeof nativeModule.startANRTracking === 'function') {
        nativeModule.startANRTracking({
          timeout: this.options.timeout,
        });
        this.logDebug('Started native ANR tracking');
      }
    } catch (error) {
      this.logError('Failed to start native ANR tracking', error);
    }
  }

  private async checkANRStatus(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    try {
      if (typeof nativeModule.getANRStatus !== 'function') {
        return;
      }

      const anrList = (await nativeModule.getANRStatus()) as string[] | null;

      if (anrList && anrList.length > 0) {
        // Push measurement for ANR count (matching Flutter pattern)
        this.api.pushMeasurement(
          {
            type: 'anr',
            values: { anr_count: anrList.length },
          },
          { skipDedupe: true }
        );

        // Push each ANR as an error with stacktrace
        for (const anrJson of anrList) {
          try {
            const anr = JSON.parse(anrJson) as ANREvent;

            this.api.pushError(new Error('ANR (Application Not Responding)'), {
              context: {
                stacktrace: anr.stacktrace,
                duration: String(anr.duration),
                timestamp: String(anr.timestamp),
              },
            });
          } catch {
            // If parsing fails, still log the raw ANR
            this.api.pushError(new Error('ANR (Application Not Responding)'), {
              context: {
                raw: anrJson,
              },
            });
          }
        }

        this.logDebug(`Recorded ${anrList.length} ANR event(s)`);
      }
    } catch (error) {
      this.logError('Failed to check ANR status', error);
    }
  }

  /**
   * Clean up resources when instrumentation is disabled.
   */
  unpatch(): void {
    // Stop polling
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }

    // Stop native tracking
    if (Platform.OS === 'android') {
      const nativeModule = this.getNativeModule();
      if (nativeModule && typeof nativeModule.stopANRTracking === 'function') {
        try {
          nativeModule.stopANRTracking();
        } catch (error) {
          this.logError('Failed to stop native ANR tracking', error);
        }
      }
    }

    this.logDebug('ANR instrumentation stopped');
  }
}
