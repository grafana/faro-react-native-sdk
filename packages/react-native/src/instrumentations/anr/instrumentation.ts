import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import { ErrorMechanism } from '../errors/const';
import {
  normalizeJavaStackTraceForRetrace,
  parseAndroidCrashTrace,
} from '../crashReporting/parseAndroidCrashTrace';

import type { ANREvent, ANRInstrumentationOptions } from './types';

/**
 * Default timeout for ANR detection (5 seconds, matching Android's threshold)
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * Default polling interval for ANR status. Kept short so debug ANRs surface without
 * waiting a full minute; native also emits onANRDetected for immediate delivery.
 */
const DEFAULT_POLLING_INTERVAL = 10000;

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
 * - Measurement: `anr` with `anr_count` value (for dashboards)
 * - Error: Each ANR with `type: 'ANR'`, stack trace, duration, timestamp (Sentry-aligned)
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
  private anrEventSubscription: ReturnType<NativeEventEmitter['addListener']> | null = null;
  private readonly reportedAnrTimestamps = new Set<number>();

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

    // Report ANRs persisted before process death (previous session or unsent this session).
    void this.drainPendingANRs(nativeModule);

    // Start native ANR tracking
    this.startNativeTracking(nativeModule);

    // Report ANRs as soon as the native tracker records them.
    const emitter = new NativeEventEmitter(nativeModule);
    this.anrEventSubscription = emitter.addListener('onANRDetected', (anrJson: string) => {
      void this.handlePendingAnrPayload(nativeModule, anrJson);
    });

    // Poll pending cache as a backup when live events are missed.
    void this.checkANRStatus(nativeModule);
    this.pollingIntervalId = setInterval(() => {
      void this.checkANRStatus(nativeModule);
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

  private async drainPendingANRs(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    const anrList = await this.fetchPendingANRs(nativeModule);
    if (!anrList?.length) {
      return;
    }

    await this.reportAndAcknowledgePendingANRs(nativeModule, anrList);
    this.logDebug(`Drained ${anrList.length} persisted ANR event(s)`);
  }

  private async handlePendingAnrPayload(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    anrJson: string
  ): Promise<void> {
    try {
      const anr = JSON.parse(anrJson) as ANREvent;
      if (this.reportANRIfNew(anr)) {
        this.api.pushMeasurement(
          {
            type: 'anr',
            values: { anr_count: 1 },
          },
          { skipDedupe: true }
        );
      }
      await this.acknowledgeANRs(nativeModule, [anr.timestamp]);
    } catch (error) {
      this.logError('Failed to parse native ANR event', error);
    }
  }

  private async fetchPendingANRs(
    nativeModule: typeof NativeModules.FaroReactNativeModule
  ): Promise<string[] | null> {
    try {
      if (typeof nativeModule.getPendingANRs === 'function') {
        return (await nativeModule.getPendingANRs()) as string[] | null;
      }

      if (typeof nativeModule.getANRStatus === 'function') {
        return (await nativeModule.getANRStatus()) as string[] | null;
      }
    } catch (error) {
      this.logError('Failed to fetch pending ANRs', error);
    }

    return null;
  }

  private async acknowledgeANRs(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    timestamps: number[]
  ): Promise<void> {
    if (!timestamps.length || typeof nativeModule.acknowledgeANRs !== 'function') {
      return;
    }

    try {
      await nativeModule.acknowledgeANRs(timestamps);
    } catch (error) {
      this.logError('Failed to acknowledge ANRs', error);
    }
  }

  private async reportAndAcknowledgePendingANRs(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    anrList: string[]
  ): Promise<void> {
    const ackTimestamps: number[] = [];

    for (const anrJson of anrList) {
      try {
        const anr = JSON.parse(anrJson) as ANREvent;
        this.reportANRIfNew(anr);
        ackTimestamps.push(anr.timestamp);
      } catch {
        const error = new Error('ANR (Application Not Responding)');
        error.stack = undefined;
        this.api.pushError(error, {
          context: {
            mechanism: ErrorMechanism.ANR,
            raw: anrJson,
          },
          type: 'ANR',
        });
      }
    }

    if (ackTimestamps.length > 0) {
      this.api.pushMeasurement(
        {
          type: 'anr',
          values: { anr_count: ackTimestamps.length },
        },
        { skipDedupe: true }
      );
      await this.acknowledgeANRs(nativeModule, ackTimestamps);
    }
  }
  /**
   * Report a detected ANR using the blocked main-thread stack, not the JS reporter stack.
   * Mirrors CrashReportingInstrumentation.sendCrashReport (error.stack cleared + stackFrames).
   */
  private reportANRIfNew(anr: ANREvent): boolean {
    if (this.reportedAnrTimestamps.has(anr.timestamp)) {
      return false;
    }
    this.reportedAnrTimestamps.add(anr.timestamp);
    this.reportANR(anr);
    return true;
  }

  private reportANR(anr: ANREvent): void {
    const rawStacktrace = anr.stacktrace?.trim() ?? '';
    const traceForRetrace = rawStacktrace ? normalizeJavaStackTraceForRetrace(rawStacktrace) : '';
    const parsed = traceForRetrace ? parseAndroidCrashTrace(traceForRetrace) : null;

    const error = new Error('ANR (Application Not Responding)');
    error.stack = undefined;

    const context: Record<string, string> = {
      duration: String(anr.duration),
      mechanism: ErrorMechanism.ANR,
      timestamp: String(anr.timestamp),
    };
    if (traceForRetrace) {
      context['stacktrace'] = traceForRetrace;
    }

    const stackFrames = parsed?.frames ?? [];
    if (!stackFrames.length && rawStacktrace) {
      this.logWarn('ANR main-thread stack present but no Java/Kotlin frames parsed');
    }

    this.api.pushError(error, {
      type: 'ANR',
      context,
      ...(stackFrames.length ? { stackFrames } : {}),
    });
  }

  private async checkANRStatus(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    try {
      const anrList = await this.fetchPendingANRs(nativeModule);

      if (anrList && anrList.length > 0) {
        await this.reportAndAcknowledgePendingANRs(nativeModule, anrList);
        this.logDebug(`Recorded ${anrList.length} ANR event(s) from pending cache`);
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

    this.anrEventSubscription?.remove();
    this.anrEventSubscription = null;
    this.reportedAnrTimestamps.clear();

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
