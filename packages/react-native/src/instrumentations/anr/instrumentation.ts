import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import { normalizeJavaStackTraceForRetrace, parseAndroidCrashTrace } from '../crashReporting/android';
import { ErrorMechanism } from '../errors/const';

import { isInvalidAnrCaptureStack } from './anrStack';
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

/** Aligns with native FaroAnrCache.MAX_TIMESTAMP_DELTA_MS */
const TIMESTAMP_DEDUP_WINDOW_MS = 10_000;

/** ApplicationExitInfo ANR traces (Android 11 / API 30+). */
const APP_EXIT_INFO_MIN_SDK = 30;

/**
 * ANR (Application Not Responding) Detection Instrumentation.
 *
 * On Android 11+, historical ANRs are read from ApplicationExitInfo (Sentry AnrV2
 * style) on the next launch. ANRTracker remains a pre-API-30 fallback and a
 * persistence backup when the OS trace stream is empty.
 *
 * ANRs stay out of CrashReportingInstrumentation so they are not replayed as
 * generic previous-session `crash` rows with empty messages.
 */
export class ANRInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-anr';
  readonly version = VERSION;

  private readonly options: Required<ANRInstrumentationOptions>;
  private pollingIntervalId: ReturnType<typeof setInterval> | null = null;
  private anrEventSubscription: ReturnType<NativeEventEmitter['addListener']> | null = null;
  private readonly reportedAnrTimestamps = new Set<number>();
  private readonly preferAppExitInfoAnr: boolean;

  constructor(options: ANRInstrumentationOptions = {}) {
    super();
    this.options = {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      pollingInterval: options.pollingInterval ?? DEFAULT_POLLING_INTERVAL,
    };
    this.preferAppExitInfoAnr = Platform.OS === 'android' && Number(Platform.Version) >= APP_EXIT_INFO_MIN_SDK;
  }

  initialize(): void {
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

    void this.drainAllAnrSources(nativeModule);

    this.startNativeTracking(nativeModule);

    const emitter = new NativeEventEmitter(nativeModule);
    this.anrEventSubscription = emitter.addListener('onANRDetected', (anrJson: string) => {
      void this.handleLiveAnrEvent(nativeModule, anrJson);
    });

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

  private async drainAllAnrSources(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    await this.drainHistoricalAnrs(nativeModule);
    await this.drainPendingANRs(nativeModule);
  }

  private async drainHistoricalAnrs(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    if (typeof nativeModule.getHistoricalAnrReports !== 'function') {
      return;
    }

    try {
      const anrList = (await nativeModule.getHistoricalAnrReports()) as string[] | null;
      if (!anrList?.length) {
        return;
      }

      const ackTimestamps: number[] = [];
      let reportedCount = 0;

      for (const anrJson of anrList) {
        try {
          const anr = JSON.parse(anrJson) as ANREvent;
          if (this.reportANRIfNew(anr)) {
            reportedCount += 1;
          }
          ackTimestamps.push(anr.timestamp);
          await this.acknowledgeNearbyPendingAnrs(nativeModule, anr.timestamp);
        } catch (error) {
          this.logError('Failed to parse historical ANR report', error);
        }
      }

      if (reportedCount > 0) {
        this.api.pushMeasurement(
          {
            type: 'anr',
            values: { anr_count: reportedCount },
          },
          { skipDedupe: true }
        );
        this.logDebug(`Reported ${reportedCount} historical ANR event(s) from ApplicationExitInfo`);
      }
    } catch (error) {
      this.logError('Failed to drain historical ANRs', error);
    }
  }

  private async drainPendingANRs(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    const anrList = await this.fetchPendingANRs(nativeModule);
    if (!anrList?.length) {
      return;
    }

    await this.reportAndAcknowledgePendingANRs(nativeModule, anrList);
    this.logDebug(`Processed ${anrList.length} persisted ANR event(s) from tracker cache`);
  }

  private async handleLiveAnrEvent(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    anrJson: string
  ): Promise<void> {
    try {
      const anr = JSON.parse(anrJson) as ANREvent;

      if (this.preferAppExitInfoAnr) {
        // Process death + ApplicationExitInfo on next launch delivers the main-thread dump.
        this.logDebug('Deferring live ANR to ApplicationExitInfo on next launch');
        return;
      }

      if (!this.shouldReportTrackerAnr(anr)) {
        await this.acknowledgeANRs(nativeModule, [anr.timestamp]);
        return;
      }

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

  private async fetchPendingANRs(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<string[] | null> {
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

  private async acknowledgeNearbyPendingAnrs(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    exitTimestamp: number
  ): Promise<void> {
    const pending = await this.fetchPendingANRs(nativeModule);
    if (!pending?.length) {
      return;
    }

    const ackTimestamps: number[] = [];
    for (const anrJson of pending) {
      try {
        const anr = JSON.parse(anrJson) as ANREvent;
        if (this.isNearbyTimestamp(anr.timestamp, exitTimestamp)) {
          ackTimestamps.push(anr.timestamp);
        }
      } catch {
        // ignore malformed cache entries
      }
    }

    if (ackTimestamps.length > 0) {
      await this.acknowledgeANRs(nativeModule, ackTimestamps);
    }
  }

  private async reportAndAcknowledgePendingANRs(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    anrList: string[]
  ): Promise<void> {
    const ackTimestamps: number[] = [];
    let reportedCount = 0;

    for (const anrJson of anrList) {
      try {
        const anr = JSON.parse(anrJson) as ANREvent;

        if (this.shouldReportTrackerAnr(anr) && this.reportANRIfNew(anr)) {
          reportedCount += 1;
        }

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

    if (reportedCount > 0) {
      this.api.pushMeasurement(
        {
          type: 'anr',
          values: { anr_count: reportedCount },
        },
        { skipDedupe: true }
      );
    }

    if (ackTimestamps.length > 0) {
      await this.acknowledgeANRs(nativeModule, ackTimestamps);
    }
  }

  private shouldReportTrackerAnr(anr: ANREvent): boolean {
    if (this.isNearbyReportedTimestamp(anr.timestamp)) {
      return false;
    }

    if (isInvalidAnrCaptureStack(anr.stacktrace)) {
      return false;
    }

    // On API 30+, ApplicationExitInfo is preferred on launch; tracker pending entries
    // are reported only when historical did not already cover the same incident.
    return true;
  }

  private reportANRIfNew(anr: ANREvent): boolean {
    if (this.isNearbyReportedTimestamp(anr.timestamp)) {
      return false;
    }

    if (isInvalidAnrCaptureStack(anr.stacktrace)) {
      return false;
    }

    this.rememberReportedTimestamp(anr.timestamp);
    this.reportANR(anr);
    return true;
  }

  private rememberReportedTimestamp(timestamp: number): void {
    this.reportedAnrTimestamps.add(timestamp);
  }

  private isNearbyReportedTimestamp(timestamp: number): boolean {
    for (const reported of Array.from(this.reportedAnrTimestamps)) {
      if (this.isNearbyTimestamp(timestamp, reported)) {
        return true;
      }
    }
    return false;
  }

  private isNearbyTimestamp(a: number, b: number): boolean {
    if (a <= 0 || b <= 0) {
      return false;
    }
    return Math.abs(a - b) <= TIMESTAMP_DEDUP_WINDOW_MS;
  }

  private reportANR(anr: ANREvent): void {
    const rawStacktrace = anr.stacktrace?.trim() ?? '';
    const traceForRetrace = rawStacktrace ? normalizeJavaStackTraceForRetrace(rawStacktrace) : '';
    const parsed = traceForRetrace ? parseAndroidCrashTrace(traceForRetrace) : null;

    const message = anr.description?.trim() || 'ANR (Application Not Responding)';
    const error = new Error(message);
    error.stack = undefined;

    const context: Record<string, string> = {
      duration: String(anr.duration),
      mechanism: ErrorMechanism.ANR,
      timestamp: String(anr.timestamp),
    };
    if (anr.source) {
      context['source'] = anr.source;
    }
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
        this.logDebug(`Polled ${anrList.length} ANR event(s) from pending cache`);
      }
    } catch (error) {
      this.logError('Failed to check ANR status', error);
    }
  }

  unpatch(): void {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }

    this.anrEventSubscription?.remove();
    this.anrEventSubscription = null;
    this.reportedAnrTimestamps.clear();

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
