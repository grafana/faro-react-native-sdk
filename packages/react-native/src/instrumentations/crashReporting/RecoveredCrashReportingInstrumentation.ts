import { NativeModules } from 'react-native';

import { TransportItemType } from '@grafana/faro-core';
import type { ExceptionEvent, Meta, TransportItem } from '@grafana/faro-core';

import { FetchTransport } from '../../transports/fetch';

import { BaseCrashReportingInstrumentation } from './BaseCrashReportingInstrumentation';
import type { CrashReport } from './types';

// Keep aligned with FaroCrashSessionStore.MAX_CONTEXT_AGE_MS on Android.
const MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type RecoveredCrashReport = CrashReport & {
  reportId: string;
  sessionId: string;
  timestamp: number;
};

/**
 * Shared recovered-crash delivery contract for native platforms.
 *
 * Native code owns crash-time persistence. JavaScript owns validation, transport
 * acceptance, and acknowledgement so retryable failures never delete a report.
 */
export abstract class RecoveredCrashReportingInstrumentation extends BaseCrashReportingInstrumentation {
  private nativeModule: typeof NativeModules.FaroReactNativeModule | null = null;
  private supportsSessionReplay = false;
  private metasListenerRegistered = false;
  private lastRecordedSessionSignature: string | null = null;
  private activeSessionId: string | null = null;
  private activeSessionActivatedAtMs = 0;
  private activeSessionIsSampled: boolean | undefined;

  private readonly recordSessionContextListener = (meta: Meta): void => {
    this.recordSessionContext(meta);
  };

  protected override prepareCrashReporting(nativeModule: typeof NativeModules.FaroReactNativeModule): void {
    this.supportsSessionReplay =
      typeof nativeModule.recordCrashSessionContext === 'function' &&
      typeof nativeModule.getPendingCrashReports === 'function' &&
      typeof nativeModule.acknowledgeCrashReports === 'function';

    if (!this.supportsSessionReplay) {
      this.logWarn('Native module does not support original-session crash replay; using legacy crash reporting');
      return;
    }

    this.nativeModule = nativeModule;
    this.recordSessionContext(this.metas.value);
    if (!this.metasListenerRegistered) {
      this.metas.addListener(this.recordSessionContextListener);
      this.metasListenerRegistered = true;
    }
  }

  protected override async processCrashReports(
    nativeModule: typeof NativeModules.FaroReactNativeModule
  ): Promise<void> {
    if (!this.supportsSessionReplay) {
      await super.processCrashReports(nativeModule);
      return;
    }

    try {
      const replayStartedAtMs = Date.now();
      const crashReports = (await nativeModule.getPendingCrashReports()) as string[] | null;
      if (!crashReports?.length) {
        this.logDebug('No crash reports from previous session');
        return;
      }

      const processedReportIds = new Set<string>();
      for (const crashJson of crashReports) {
        let parsedCrash: unknown;
        try {
          parsedCrash = JSON.parse(crashJson);
        } catch (error) {
          this.logError('Failed to parse recovered crash report', error);
          continue;
        }
        if (!parsedCrash || typeof parsedCrash !== 'object' || Array.isArray(parsedCrash)) {
          this.logWarn('Skipping malformed recovered crash report');
          continue;
        }
        const crash = parsedCrash as CrashReport;

        const reportId = crash.reportId?.trim();
        if (!reportId) {
          this.logWarn('Skipping malformed recovered crash report');
          continue;
        }
        if (!this.hasValidTimestamp(crash)) {
          this.logWarn(`Discarding malformed recovered crash ${reportId}`);
          await this.acknowledgeCrashReport(nativeModule, reportId);
          continue;
        }
        if (processedReportIds.has(reportId)) {
          this.logDebug(`Skipping duplicate recovered crash report ${reportId}`);
          continue;
        }
        processedReportIds.add(reportId);

        if (!this.isWithinReplayWindow(crash.timestamp, replayStartedAtMs)) {
          await this.acknowledgeCrashReport(nativeModule, reportId);
          continue;
        }
        if (this.shouldSkipCrashReport(crash)) {
          await this.acknowledgeCrashReport(nativeModule, reportId);
          continue;
        }

        const sessionId = crash.sessionId?.trim();
        if (!sessionId) {
          this.logWarn(`Discarding recovered crash ${reportId} because its original session context is unavailable`);
          await this.acknowledgeCrashReport(nativeModule, reportId);
          continue;
        }

        const outcome = await this.replayCrashReport({
          ...crash,
          reportId,
          sessionId,
        });
        if (outcome === 'accepted' || outcome === 'filtered') {
          await this.acknowledgeCrashReport(nativeModule, reportId);
        }
      }
    } catch (error) {
      this.logError('Failed to process recovered crash reports', error);
    }
  }

  private recordSessionContext(meta: Meta): void {
    const sessionId = meta.session?.id?.trim();
    if (!sessionId || !this.nativeModule) {
      return;
    }

    if (this.activeSessionId !== sessionId) {
      this.activeSessionId = sessionId;
      this.activeSessionActivatedAtMs = Date.now();
      this.activeSessionIsSampled = undefined;
    }

    const sampledValue = meta.session?.attributes?.['isSampled'];
    const incomingIsSampled = sampledValue === 'true' ? true : sampledValue === 'false' ? false : undefined;
    if (incomingIsSampled !== undefined) {
      this.activeSessionIsSampled = incomingIsSampled;
    }
    const isSampled = incomingIsSampled ?? this.activeSessionIsSampled;
    const sessionContext = {
      sessionId,
      activatedAt: this.activeSessionActivatedAtMs,
      ...(isSampled === undefined ? {} : { isSampled }),
      ...(meta.app?.version ? { appVersion: meta.app.version } : {}),
      ...(meta.app?.release ? { appRelease: meta.app.release } : {}),
      ...(meta.app?.bundleId ? { appBundleId: meta.app.bundleId } : {}),
    };
    const signature = JSON.stringify(sessionContext);
    if (signature === this.lastRecordedSessionSignature) {
      return;
    }

    try {
      const stored = this.nativeModule.recordCrashSessionContext(sessionContext);
      if (stored === true) {
        this.lastRecordedSessionSignature = signature;
      }
    } catch (error) {
      this.logError('Failed to persist crash session context', error);
    }
  }

  private async replayCrashReport(crash: RecoveredCrashReport): Promise<'accepted' | 'filtered' | 'retry'> {
    if (this.transports.isPaused()) {
      return 'retry';
    }

    const fetchTransport = this.transports.transports.find(
      (transport): transport is FetchTransport => transport instanceof FetchTransport
    );
    if (!fetchTransport) {
      this.logWarn('Fetch transport is unavailable; leaving recovered crash pending');
      return 'retry';
    }

    // Recovered crashes intentionally bypass transport fan-out. Native storage
    // handles retries, and only FetchTransport reports collector acceptance before ack.
    let item: TransportItem = this.buildRecoveredCrashItem(crash);
    try {
      for (const hook of this.transports.getBeforeSendHooks()) {
        const modifiedItem = hook(item);
        // Match faro-core's filter(Boolean) behavior for invalid hook results.
        if (!modifiedItem) {
          return 'filtered';
        }
        item = modifiedItem;
      }
    } catch (error) {
      this.logError('Failed to apply beforeSend hook to recovered crash', error);
      return 'retry';
    }

    const result = await fetchTransport.sendWithResult([item]);
    return result.outcome === 'accepted' ? 'accepted' : 'retry';
  }

  private buildRecoveredCrashItem(crash: RecoveredCrashReport): TransportItem<ExceptionEvent> {
    const { context, errorMessage, stackFrames } = this.buildCrashReportDetails(crash);
    const currentMeta = this.metas.value;
    const isSampledAttribute = crash.isSampled === undefined ? undefined : { isSampled: String(crash.isSampled) };
    // Current user, view, and page metadata belong to the restarted session.
    const meta: Meta = {
      ...(currentMeta.sdk ? { sdk: { ...currentMeta.sdk } } : {}),
      app: {
        ...(currentMeta.app ?? {}),
        ...(crash.appVersion ? { version: crash.appVersion } : {}),
        ...(crash.appRelease ? { release: crash.appRelease } : {}),
        ...(crash.appBundleId ? { bundleId: crash.appBundleId } : {}),
      },
      ...(currentMeta.os ? { os: { ...currentMeta.os } } : {}),
      ...(currentMeta.device ? { device: { ...currentMeta.device } } : {}),
      session: {
        id: crash.sessionId,
        ...(isSampledAttribute ? { attributes: isSampledAttribute } : {}),
      },
    };

    return {
      type: TransportItemType.EXCEPTION,
      meta,
      payload: {
        type: 'crash',
        value: errorMessage,
        timestamp: new Date(crash.timestamp).toISOString(),
        context,
        fatal: true,
        ...(stackFrames.length ? { stacktrace: { frames: stackFrames } } : {}),
      },
    };
  }

  private async acknowledgeCrashReport(
    nativeModule: typeof NativeModules.FaroReactNativeModule,
    reportId: string
  ): Promise<void> {
    try {
      await nativeModule.acknowledgeCrashReports([reportId]);
    } catch (error) {
      this.logError(`Failed to acknowledge recovered crash ${reportId}`, error);
    }
  }

  private hasValidTimestamp(crash: CrashReport): crash is CrashReport & { timestamp: number } {
    return typeof crash.timestamp === 'number' && Number.isFinite(crash.timestamp) && crash.timestamp > 0;
  }

  private isWithinReplayWindow(timestampMs: number, replayStartedAtMs: number): boolean {
    return timestampMs <= replayStartedAtMs && replayStartedAtMs - timestampMs <= MAX_REPLAY_AGE_MS;
  }

  override unpatch(): void {
    if (this.metasListenerRegistered) {
      this.metas.removeListener(this.recordSessionContextListener);
      this.metasListenerRegistered = false;
    }
    this.nativeModule = null;
    this.supportsSessionReplay = false;
    this.lastRecordedSessionSignature = null;
    this.activeSessionId = null;
    this.activeSessionActivatedAtMs = 0;
    this.activeSessionIsSampled = undefined;
    super.unpatch();
  }
}
