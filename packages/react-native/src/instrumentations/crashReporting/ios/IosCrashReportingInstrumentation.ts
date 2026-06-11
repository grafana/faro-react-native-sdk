import { VERSION } from '@grafana/faro-core';

import { BaseCrashReportingInstrumentation } from '../BaseCrashReportingInstrumentation';
import type { CrashReport } from '../types';

import { resolveCrashErrorMessage, shouldSkipCrashReport } from './crashErrorMessage';
import { type ParsedIosCrashTrace, parseIosCrashTrace } from './parseIosCrashTrace';

/**
 * iOS Crash Reporting Instrumentation.
 *
 * Uses PLCrashReporter to capture native crashes from previous sessions:
 * - SIGSEGV: Segmentation fault / invalid memory access
 * - SIGABRT: Abnormal termination (e.g., assertion failure, uncaught exception)
 * - SIGBUS: Bus error / alignment/hardware error
 * - SIGILL: Illegal instruction
 * - SIGFPE: Floating point exception
 * - SIGTRAP: Breakpoint/debugger trap
 * - Mach exceptions (EXC_BAD_ACCESS, EXC_CRASH, etc.)
 *
 * Stack frames are symbolicated on the native side before being surfaced.
 */
export class IosCrashReportingInstrumentation extends BaseCrashReportingInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-crash-ios';
  readonly version = VERSION;

  protected parseCrashTrace(trace: string): ParsedIosCrashTrace | null {
    return parseIosCrashTrace(trace);
  }

  protected resolveCrashErrorMessage(crash: CrashReport, parsedTrace: ParsedIosCrashTrace | null): string {
    return resolveCrashErrorMessage(crash, parsedTrace);
  }

  protected shouldSkipCrashReport(crash: CrashReport): boolean {
    return shouldSkipCrashReport(crash);
  }

  protected getStackFrames(parsedTrace: ParsedIosCrashTrace | null): any[] {
    return parsedTrace?.frames ?? [];
  }

  protected buildPlatformContext(parsedTrace: ParsedIosCrashTrace | null, context: Record<string, string>): void {
    if (parsedTrace?.exceptionName) {
      context['nativeExceptionName'] = parsedTrace.exceptionName;
    }
    if (parsedTrace?.signalName) {
      context['signalName'] = parsedTrace.signalName;
    }
    if (parsedTrace?.signalDescription) {
      context['signalDescription'] = parsedTrace.signalDescription;
    }
  }

  protected getParseFailureWarning(): string {
    return 'Native crash trace present but no frames parsed; check iOS PLCrashReporter format';
  }

  protected getTraceUnavailableWarning(): string {
    return 'Native crash trace unavailable (PLCrashReporter trace was null at crash time)';
  }
}
