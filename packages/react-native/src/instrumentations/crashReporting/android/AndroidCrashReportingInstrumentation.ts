import { VERSION } from '@grafana/faro-core';

import { BaseCrashReportingInstrumentation } from '../BaseCrashReportingInstrumentation';
import type { CrashReport } from '../types';

import { resolveCrashErrorMessage, shouldSkipCrashReport } from './crashErrorMessage';
import { parseAndroidCrashTrace, type ParsedAndroidCrashTrace } from './parseAndroidCrashTrace';

/**
 * Android Crash Reporting Instrumentation.
 *
 * Uses ApplicationExitInfo API (Android 11+ / API 30+) to retrieve crash reports
 * from previous sessions. Captures:
 * - CRASH: Java/Kotlin exception crashes
 * - CRASH_NATIVE: Native (NDK) crashes
 * - LOW_MEMORY: App killed due to low memory
 * - EXCESSIVE_RESOURCE_USAGE: App killed due to excessive resource usage
 *
 * ANRs are reported separately by ANRInstrumentation, not via ApplicationExitInfo replay.
 */
export class AndroidCrashReportingInstrumentation extends BaseCrashReportingInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-crash-android';
  readonly version = VERSION;

  protected parseCrashTrace(trace: string): ParsedAndroidCrashTrace | null {
    return parseAndroidCrashTrace(trace, {
      releaseBundleFilename: this.options.releaseBundleFilename,
    });
  }

  protected resolveCrashErrorMessage(crash: CrashReport, parsedTrace: ParsedAndroidCrashTrace | null): string {
    return resolveCrashErrorMessage(crash, parsedTrace);
  }

  protected shouldSkipCrashReport(crash: CrashReport): boolean {
    return shouldSkipCrashReport(crash);
  }

  protected getStackFrames(parsedTrace: ParsedAndroidCrashTrace | null): any[] {
    if (!parsedTrace) {
      return [];
    }
    // Android has JS frames, Java/Kotlin frames (R8 retrace), and NDK tombstone rows (.so retrace).
    return [...(parsedTrace.jsFrames ?? []), ...(parsedTrace.frames ?? []), ...(parsedTrace.nativeFrames ?? [])];
  }

  protected buildPlatformContext(parsedTrace: ParsedAndroidCrashTrace | null, context: Record<string, string>): void {
    // Store the native Java/Kotlin exception class separately for drill-down
    // Plugin overview metrics key off exception_type = 'crash', so keep that stable
    if (parsedTrace?.exceptionType) {
      context['nativeExceptionType'] = parsedTrace.exceptionType;
    }
  }

  protected getParseFailureWarning(): string {
    return 'Native crash trace present but no frames parsed; check Android trace format or UncaughtExceptionHandler cache';
  }

  protected getTraceUnavailableWarning(): string {
    return 'Native crash trace unavailable (ApplicationExitInfo traceInputStream was null at crash time)';
  }
}
