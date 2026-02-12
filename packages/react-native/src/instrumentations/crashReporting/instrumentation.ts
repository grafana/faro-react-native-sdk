import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import { NativeModules } from 'react-native';

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

    // Get crash reports from previous session
    await this.processCrashReports(nativeModule);
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

      const crashReports = (await nativeModule.getCrashReport()) as string[] | null;

      if (!crashReports || crashReports.length === 0) {
        this.logDebug('No crash reports from previous session');
        return;
      }

      this.logDebug(`Processing ${crashReports.length} crash report(s) from previous session`);

      for (const crashJson of crashReports) {
        try {
          const crash = JSON.parse(crashJson) as CrashReport;
          this.sendCrashReport(crash);
        } catch {
          // If parsing fails, still try to report something
          this.api.pushError(new Error('Application crash (parse error)'), {
            context: {
              raw: crashJson,
            },
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
    const context: Record<string, string> = {};

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

    // Include crashed session ID for correlation in consumer apps.
    // This allows users to query events from the session where the crash occurred
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
