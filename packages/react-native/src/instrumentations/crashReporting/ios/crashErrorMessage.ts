import type { CrashReport } from '../types';

import type { ParsedIosCrashTrace } from './parseIosCrashTrace';

/**
 * Human-readable exception value for iOS PLCrashReporter crash reports.
 * Priority: exception reason → signal description → signal name → fallback.
 */
export function resolveCrashErrorMessage(crash: CrashReport, parsedTrace: ParsedIosCrashTrace | null): string {
  // iOS uncaught exceptions (NSException) have name and reason
  if (parsedTrace?.exceptionName || parsedTrace?.exceptionReason) {
    const name = parsedTrace.exceptionName || 'Exception';
    const reason = parsedTrace.exceptionReason?.trim();
    if (reason) {
      return `${name}: ${reason}`;
    }
    return name;
  }

  // Use signal description if available from parsed trace
  if (parsedTrace?.signalDescription?.trim()) {
    return parsedTrace.signalDescription.trim();
  }

  // Use signal name from parsed trace
  if (parsedTrace?.signalName?.trim()) {
    const signalName = parsedTrace.signalName.trim();
    const description = SIGNAL_DESCRIPTIONS[signalName];
    return description || signalName;
  }

  // Check crash description - use if meaningful
  const description = crash.description?.trim();
  if (description && !isGenericCrashDescription(description)) {
    return description;
  }

  // Check if we have a known signal reason
  const reason = crash.reason?.trim();
  if (reason && SIGNAL_DESCRIPTIONS[reason]) {
    // If description is explicitly generic, use full format
    if (description && isGenericCrashDescription(description)) {
      return buildFallbackCrashMessage(crash);
    }
    // No description - use simple signal description
    return SIGNAL_DESCRIPTIONS[reason];
  }

  // Final fallback: format with signal name, description, and status
  return buildFallbackCrashMessage(crash);
}

/**
 * Skip crash reports that have no useful information.
 * iOS crashes should always have either a trace or a signal.
 */
export function shouldSkipCrashReport(crash: CrashReport): boolean {
  if (crash.trace?.trim()) {
    return false;
  }

  if (crash.signal?.trim()) {
    return false;
  }

  const description = crash.description?.trim();
  if (description && !isGenericCrashDescription(description)) {
    return false;
  }

  return true;
}

/** BSD signal names to human-readable descriptions */
const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  SIGHUP: 'Hangup',
  SIGINT: 'Interrupt',
  SIGQUIT: 'Quit',
  SIGILL: 'Illegal instruction',
  SIGTRAP: 'Trace/BPT trap',
  SIGABRT: 'Abort trap',
  SIGEMT: 'EMT trap',
  SIGFPE: 'Floating point exception',
  SIGKILL: 'Killed',
  SIGBUS: 'Bus error',
  SIGSEGV: 'Segmentation fault',
  SIGSYS: 'Bad system call',
  SIGPIPE: 'Broken pipe',
  SIGALRM: 'Alarm clock',
  SIGTERM: 'Terminated',
};

function isGenericCrashDescription(description: string): boolean {
  const normalized = description.trim().toLowerCase();
  return normalized === 'crash' || normalized === 'application crash' || normalized === 'signal crash';
}

/** Generic fallback when the trace carries no parseable signal or description. */
export function buildFallbackCrashMessage(crash: CrashReport): string {
  const reason = crash.reason || 'UNKNOWN';
  const status = crash.status ?? 0;

  let description: string;
  if (SIGNAL_DESCRIPTIONS[reason]) {
    description = SIGNAL_DESCRIPTIONS[reason];
  } else {
    description = crash.description || 'Application crash';
  }

  return `${reason}: ${description}, status: ${status}`;
}
