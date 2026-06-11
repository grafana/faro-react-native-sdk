import { NativeModules } from 'react-native';

import { BaseInstrumentation } from '@grafana/faro-core';

import type { CrashReport, CrashReportingOptions } from './types';

/**
 * Abstract base class for platform-specific crash reporting implementations.
 *
 * Defines the common contract that both Android and iOS implementations must follow.
 * Handles the shared logic for retrieving crash reports from native modules and
 * processing them, while delegating platform-specific parsing and validation to subclasses.
 */
export abstract class BaseCrashReportingInstrumentation extends BaseInstrumentation {
  abstract override readonly name: string;
  abstract override readonly version: string;

  protected readonly options: { enabled: boolean; releaseBundleFilename?: string };

  constructor(options: CrashReportingOptions = {}) {
    super();
    this.options = {
      enabled: options.enabled ?? true,
      releaseBundleFilename: options.releaseBundleFilename,
    };
  }

  async initialize(): Promise<void> {
    if (!this.options.enabled) {
      this.logDebug('Crash reporting is disabled');
      return;
    }

    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      this.logWarn('Native module not available for crash reporting');
      return;
    }

    this.logDebug('Initializing crash reporting instrumentation');

    // Wait for session attributes before sending crash reports
    await this.waitForSessionAttributes();

    // Get and process crash reports from previous session
    await this.processCrashReports(nativeModule);
  }

  /**
   * Platform-specific: Parse a crash trace string into structured stack frames.
   */
  protected abstract parseCrashTrace(trace: string): any | null;

  /**
   * Platform-specific: Resolve human-readable error message from crash data.
   */
  protected abstract resolveCrashErrorMessage(crash: CrashReport, parsedTrace: any | null): string;

  /**
   * Platform-specific: Determine if a crash report should be skipped.
   */
  protected abstract shouldSkipCrashReport(crash: CrashReport): boolean;

  /**
   * Platform-specific: Extract stack frames from parsed trace.
   */
  protected abstract getStackFrames(parsedTrace: any | null): any[];

  /**
   * Platform-specific: Build platform-specific context from parsed trace.
   */
  protected abstract buildPlatformContext(parsedTrace: any | null, context: Record<string, string>): void;

  /**
   * Platform-specific: Get warning message when trace parsing fails.
   */
  protected abstract getParseFailureWarning(): string;

  /**
   * Platform-specific: Get warning message when trace is unavailable.
   */
  protected abstract getTraceUnavailableWarning(): string;

  private async waitForSessionAttributes(maxWaitMs = 10000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 200;
    let checkCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      checkCount++;
      try {
        const sessionAttrs = this.metas?.value?.session?.attributes;

        if (sessionAttrs) {
          const attrCount = Object.keys(sessionAttrs).length;
          const attrKeys = JSON.stringify(Object.keys(sessionAttrs));

          // Look for multiple device-specific attributes that indicate full async collection is done.
          // getSessionAttributes() collects these asynchronously:
          // - device_id (SDK installation id, kept as a flat attr during migration)
          // - device_os_detail (async getDeviceOsDetail)
          // - device_model_name (DeviceInfo.getDeviceNameSync)
          // All three should be present when collection is complete.
          const hasDeviceId = 'device_id' in sessionAttrs && sessionAttrs['device_id'] !== 'unknown';
          const hasDeviceOsDetail =
            'device_os_detail' in sessionAttrs && sessionAttrs['device_os_detail'] !== 'unknown';
          const hasDeviceModelName = 'device_model_name' in sessionAttrs;

          if (hasDeviceId && hasDeviceOsDetail && hasDeviceModelName) {
            const elapsed = Date.now() - startTime;
            this.logDebug(`Session attributes ready after ${elapsed}ms (${checkCount} checks, ${attrCount} attrs)`);
            return;
          } else {
            this.logDebug(
              `Check #${checkCount}: Found ${attrCount} session attributes: ${attrKeys} but still missing required attrs - device_id:${hasDeviceId}, device_os_detail:${hasDeviceOsDetail}, device_model_name:${hasDeviceModelName}`
            );
          }
        } else {
          this.logDebug(`Check #${checkCount}: No session attributes available yet`);
        }
      } catch (error) {
        this.logDebug(`Check #${checkCount}: Error accessing metas: ${error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const finalAttrs = this.metas?.value?.session?.attributes;
    const finalAttrCount = finalAttrs ? Object.keys(finalAttrs).length : 0;
    const finalAttrKeys = finalAttrs ? JSON.stringify(Object.keys(finalAttrs)) : 'none';
    this.logWarn(
      `Session attributes not ready after ${maxWaitMs}ms timeout (${checkCount} checks, ${finalAttrCount} attrs: ${finalAttrKeys}). Sending crash report anyway.`
    );
  }

  private getNativeModule(): typeof NativeModules.FaroReactNativeModule | null {
    const { FaroReactNativeModule } = NativeModules;

    if (!FaroReactNativeModule) {
      return null;
    }

    return FaroReactNativeModule;
  }

  private async processCrashReports(nativeModule: typeof NativeModules.FaroReactNativeModule): Promise<void> {
    try {
      if (typeof nativeModule.getCrashReport !== 'function') {
        this.logDebug('getCrashReport method not available');
        return;
      }

      this.logDebug('Attempting to retrieve crash reports from native module');
      const crashReports = (await nativeModule.getCrashReport()) as string[] | null;

      if (!crashReports || crashReports.length === 0) {
        this.logDebug('No crash reports from previous session');
        return;
      }

      this.logDebug(`Processing ${crashReports.length} crash report(s) from previous session`);

      const reportedTimestamps = new Set<number>();

      for (const crashJson of crashReports) {
        try {
          this.logDebug(`Parsing crash report JSON: ${crashJson.substring(0, 200)}...`);
          const crash = JSON.parse(crashJson) as CrashReport;

          if (crash.timestamp && reportedTimestamps.has(crash.timestamp)) {
            this.logDebug(`Skipping duplicate crash report at ${crash.timestamp}`);
            continue;
          }

          if (this.shouldSkipCrashReport(crash)) {
            this.logDebug(`Skipping crash report at ${crash.timestamp} (platform-specific skip logic)`);
            continue;
          }

          if (crash.timestamp) {
            reportedTimestamps.add(crash.timestamp);
          }

          this.sendCrashReport(crash);
        } catch (parseError) {
          this.logError('Failed to parse crash report JSON', parseError);
          this.api.pushError(new Error('Application crash (parse error)'), {
            context: {
              mechanism: 'crash',
              parseError: String(parseError),
              raw: crashJson.substring(0, 500),
            },
            fatal: true,
            type: 'crash',
          });
        }
      }
    } catch (error) {
      this.logError('Failed to process crash reports', error);
    }
  }

  private sendCrashReport(crash: CrashReport): void {
    // Platform-specific parsing
    const parsedTrace = crash.trace ? this.parseCrashTrace(crash.trace) : null;
    const errorMessage = this.resolveCrashErrorMessage(crash, parsedTrace).trim() || 'Application crash';

    // Use a message-only Error so pushError does not capture the JS reporter stack
    const error = new Error(errorMessage);
    error.stack = undefined;

    // Build context from crash data
    const context: Record<string, string> = {
      mechanism: 'crash',
    };

    if (crash.trace) {
      context['trace'] = crash.trace;
    }
    if (crash.signal) {
      context['signal'] = crash.signal;
    }
    if (crash.timestamp) {
      context['timestamp'] = String(crash.timestamp);
    }
    if (crash.description) {
      context['description'] = crash.description;
    }
    if (crash.processName) {
      context['processName'] = crash.processName;
    }
    if (crash.pid) {
      context['pid'] = String(crash.pid);
    }
    if (crash.importance !== undefined) {
      context['importance'] = String(crash.importance);
    }

    // Platform-specific context
    this.buildPlatformContext(parsedTrace, context);

    // Platform-specific stack frames
    const stackFrames = this.getStackFrames(parsedTrace);

    // Warnings for missing/unparseable traces
    if (!stackFrames.length && crash.trace) {
      this.logWarn(this.getParseFailureWarning());
    } else if (!crash.trace) {
      this.logWarn(this.getTraceUnavailableWarning());
    }

    this.api.pushError(error, {
      stackFrames,
      context,
      type: 'crash',
      fatal: true,
    });

    this.logDebug(`Sent crash report: ${errorMessage}`);
  }

  // Logging helpers
  override logDebug(message: string, ...args: any[]): void {
    this.internalLogger?.debug?.(message, ...args);
  }

  override logInfo(message: string, ...args: any[]): void {
    this.internalLogger?.info?.(message, ...args);
  }

  override logWarn(message: string, ...args: any[]): void {
    this.internalLogger?.warn?.(message, ...args);
  }

  override logError(message: string, ...args: any[]): void {
    this.internalLogger?.error?.(message, ...args);
  }

  unpatch(): void {
    // No patching to undo
  }
}
