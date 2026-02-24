import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import { NativeModules } from 'react-native';

import { ErrorMechanism } from '../errors/const';
import type { CrashReport, CrashReportingOptions } from './types';

/**
 * Crash Reporting Instrumentation (Experimental).
 *
 * Retrieves crash reports from previous app sessions and sends them via Faro API.
 *
 * **Platform Support**:
 * - **Android**: Uses ApplicationExitInfo API (Android 11+ / API 30+)
 *   Captures: CRASH, CRASH_NATIVE, ANR, LOW_MEMORY, EXCESSIVE_RESOURCE_USAGE
 * - **iOS**: Uses PLCrashReporter (requires adding dependency to podspec)
 *   Captures: Signal crashes (SIGSEGV, SIGABRT, etc.) and Mach exceptions
 *
 * **Note**: This instrumentation only retrieves crash data from previous sessions.
 * The crash itself terminates the app, so the report is sent on next app launch.
 *
 * @example
 * ```typescript
 * import { initializeFaro, CrashReportingInstrumentation } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   url: 'https://collector.example.com',
 *   instrumentations: [
 *     new CrashReportingInstrumentation(),
 *   ],
 * });
 * ```
 */
export class CrashReportingInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-crash';
  readonly version = VERSION;

  private readonly options: Required<CrashReportingOptions>;

  constructor(options: CrashReportingOptions = {}) {
    super();
    this.options = {
      enabled: options.enabled ?? true,
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

    // Wait for session attributes to be populated before sending crash reports
    // This ensures crash reports include full session metadata
    await this.waitForSessionAttributes();

    // Get crash reports from previous session
    await this.processCrashReports(nativeModule);
  }

  /**
   * Wait for session attributes to be populated.
   *
   * Crash reports are sent in a new session, so we need to wait for
   * SessionInstrumentation to finish collecting device info, OS version, etc.
   * before sending the crash report. Otherwise, the crash report will be missing
   * session metadata.
   *
   * This checks for multiple device-specific attributes that are collected
   * asynchronously (device_id, device_os_detail, device_model_name) to ensure
   * the async getSessionAttributes() call has completed.
   *
   * @param maxWaitMs Maximum time to wait in milliseconds (default 10000ms)
   */
  private async waitForSessionAttributes(maxWaitMs = 10000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 200; // Check every 200ms
    let checkCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      checkCount++;
      try {
        // Check if session attributes are populated
        const sessionAttrs = this.metas?.value?.session?.attributes;

        if (sessionAttrs) {
          const attrCount = Object.keys(sessionAttrs).length;
          const attrKeys = JSON.stringify(Object.keys(sessionAttrs));

          // Look for multiple device-specific attributes that indicate full async collection is done.
          // getSessionAttributes() collects these asynchronously:
          // - device_id (async getDeviceId)
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
        // Continue waiting if we can't access metas yet
        this.logDebug(`Check #${checkCount}: Error accessing metas: ${error}`);
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout reached - log warning but continue
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

      for (const crashJson of crashReports) {
        try {
          this.logDebug(`Parsing crash report JSON: ${crashJson.substring(0, 200)}...`);
          const crash = JSON.parse(crashJson) as CrashReport;
          this.sendCrashReport(crash);
        } catch (parseError) {
          // If parsing fails, still try to report something
          this.logError('Failed to parse crash report JSON', parseError);
          this.api.pushError(new Error('Application crash (parse error)'), {
            context: {
              mechanism: ErrorMechanism.CRASH,
              parseError: String(parseError),
              raw: crashJson.substring(0, 500), // Limit size
            },
            type: 'crash',
          });
        }
      }
    } catch (error) {
      this.logError('Failed to process crash reports', error);
    }
  }

  private sendCrashReport(crash: CrashReport): void {
    const errorMessage = this.getErrorMessage(crash);
    const error = new Error(errorMessage);

    // Build context from crash data (matching Flutter pattern)
    const context: Record<string, string> = {
      mechanism: ErrorMechanism.CRASH,
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

    // Include crashed session ID for correlation.
    // This allows querying events from the session where the crash occurred.
    if (crash.crashedSessionId) {
      context['crashedSessionId'] = crash.crashedSessionId;
    }

    // Push as error via Faro API (matching Flutter pattern)
    this.api.pushError(error, {
      type: 'crash',
      context,
    });

    this.logDebug(`Reported crash: ${crash.reason} at ${crash.timestamp}`);
  }

  /**
   * Build error message matching Flutter SDK format:
   * "{reason}: {description}, status: {status}"
   */
  private getErrorMessage(crash: CrashReport): string {
    const reason = crash.reason || 'UNKNOWN';
    const status = crash.status ?? 0;

    let description: string;
    switch (crash.reason) {
      case 'ANR':
        description = 'Application Not Responding';
        break;
      case 'CRASH':
        description = 'Application crash (Java/Kotlin)';
        break;
      case 'CRASH_NATIVE':
        description = 'Application crash (Native)';
        break;
      case 'LOW_MEMORY':
        description = 'Application terminated due to low memory';
        break;
      case 'EXCESSIVE_RESOURCE_USAGE':
        description = 'Application terminated due to excessive resource usage';
        break;
      case 'INITIALIZATION_FAILURE':
        description = 'Application failed to initialize';
        break;
      default:
        description = crash.description || 'Application crash';
        break;
    }

    return `${reason}: ${description}, status: ${status}`;
  }
}
