import type { CrashReport } from '../types';

import { isPlausibleJavaExceptionIdentifier } from './parseAndroidCrashTrace';
import type { ParsedAndroidCrashTrace } from './parseAndroidCrashTrace';

/**
 * Human-readable exception value for ApplicationExitInfo crash reports.
 * Priority: parsed trace message → exception class → description → generic fallback.
 */
export function resolveCrashErrorMessage(crash: CrashReport, parsedTrace: ParsedAndroidCrashTrace | null): string {
  const fromTrace = parsedTrace?.exceptionMessage?.trim();
  if (fromTrace) {
    return fromTrace;
  }

  const fromType = parsedTrace?.exceptionType?.trim();
  if (fromType && isPlausibleJavaExceptionIdentifier(fromType)) {
    return fromType;
  }

  const fromDescriptionType = exceptionTypeFromDescription(crash.description);
  if (fromDescriptionType) {
    return fromDescriptionType;
  }

  const fromDescription = crash.description?.trim();
  if (fromDescription && !isGenericCrashDescription(fromDescription)) {
    return fromDescription;
  }

  const fallback = buildFallbackCrashMessage(crash);
  return fallback.trim() || crash.reason || 'Application crash';
}

const ANR_TIMEOUT_DESCRIPTION_PATTERN = /input dispatching timed out|not responding|application not responding/i;

/**
 * Android ANR watchdog descriptions from ApplicationExitInfo (any app).
 */
export function isAnrTimeoutDescription(description: string | undefined): boolean {
  const trimmed = description?.trim();
  if (!trimmed) {
    return false;
  }
  return ANR_TIMEOUT_DESCRIPTION_PATTERN.test(trimmed);
}

/**
 * Skip duplicate ApplicationExitInfo rows that have no stack and no useful title,
 * and ANR incidents mis-tagged as previous-session crashes.
 */
export function shouldSkipCrashReport(crash: CrashReport): boolean {
  if (isAnrTimeoutDescription(crash.description)) {
    return true;
  }

  return shouldSkipLowSignalCrashReport(crash);
}

/**
 * Skip duplicate ApplicationExitInfo rows that have no stack and no useful title.
 * These surface in the plugin as a second generic `crash` row for a single button press.
 */
export function shouldSkipLowSignalCrashReport(crash: CrashReport): boolean {
  if (crash.trace?.trim()) {
    return false;
  }

  const description = crash.description?.trim();
  if (description && !isGenericCrashDescription(description)) {
    return false;
  }

  return true;
}

/** Extract `java.lang.NullPointerException` from ApplicationExitInfo description text. */
function exceptionTypeFromDescription(description: string | undefined): string | undefined {
  const trimmed = description?.trim();
  if (!trimmed || isGenericCrashDescription(trimmed)) {
    return undefined;
  }

  const match = trimmed.match(/^([\w.$]+)(?::(.*))?$/);
  const candidate = match?.[1]?.trim();
  if (!candidate || !isPlausibleJavaExceptionIdentifier(candidate)) {
    return undefined;
  }

  return candidate;
}

function isGenericCrashDescription(description: string): boolean {
  const normalized = description.trim().toLowerCase();
  return (
    normalized === 'crash' ||
    normalized === 'native crash' ||
    normalized === 'application crash' ||
    normalized === 'application crash (java/kotlin)' ||
    normalized === 'application crash (native)'
  );
}

/** Generic fallback when the trace carries no parseable message or type. */
export function buildFallbackCrashMessage(crash: CrashReport): string {
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
