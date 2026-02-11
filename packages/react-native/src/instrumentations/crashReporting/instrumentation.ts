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

      // Clear processed crash reports
      if (typeof nativeModule.clearCrashReports === 'function') {
        await nativeModule.clearCrashReports();
      }
    } catch (error) {
      this.logError('Failed to process crash reports', error);
    }
  }

  private sendCrashReport(crash: CrashReport): void {
    const errorMessage = this.getErrorMessage(crash);
    const error = new Error(errorMessage);

    // Build context from crash data
    const context: Record<string, string> = {};

    const stacktrace = crash.stacktrace;
    const signal = crash.signal;
    const timestamp = crash.timestamp;
    const timestampReadable = crash.timestamp_readable_utc;
    const description = crash.description;
    const processName = crash.processName;
    const pid = crash.pid;
    const status = crash.status;
    const importance = crash.importance;

    if (stacktrace) {
      context['stacktrace'] = stacktrace;
    }
    if (signal) {
      context['signal'] = signal;
    }
    if (timestamp) {
      context['timestamp'] = String(timestamp);
    }
    if (timestampReadable) {
      context['timestamp_readable_utc'] = timestampReadable;
    }
    if (description) {
      context['description'] = description;
    }
    if (processName) {
      context['processName'] = processName;
    }
    if (pid) {
      context['pid'] = String(pid);
    }
    if (status !== undefined) {
      context['status'] = String(status);
    }
    if (importance !== undefined) {
      context['importance'] = String(importance);
    }

    // Push as error via Faro API (matching Flutter pattern)
    this.api.pushError(error, {
      type: crash.type || 'crash',
      context,
    });

    this.logDebug(`Reported crash: ${crash.type} at ${timestampReadable || timestamp}`);
  }

  private getErrorMessage(crash: CrashReport): string {
    switch (crash.type) {
      case 'ANR':
        return 'ANR (Application Not Responding)';
      case 'CRASH':
        return 'Application crash (Java/Kotlin)';
      case 'CRASH_NATIVE':
        return 'Application crash (Native)';
      case 'LOW_MEMORY':
        return 'Application terminated due to low memory';
      case 'EXCESSIVE_RESOURCE_USAGE':
        return 'Application terminated due to excessive resource usage';
      case 'INITIALIZATION_FAILURE':
        return 'Application failed to initialize';
      default:
        return crash.description || `Application crash (${crash.type})`;
    }
  }
}
