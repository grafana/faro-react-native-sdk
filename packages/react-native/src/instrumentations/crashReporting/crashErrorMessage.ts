import type { ParsedAndroidCrashTrace } from './parseAndroidCrashTrace';
import type { CrashReport } from './types';

/**
 * Human-readable exception value for ApplicationExitInfo crash reports.
 * Priority: parsed trace message → system description → exception class → Flutter-style fallback.
 */
export function resolveCrashErrorMessage(
  crash: CrashReport,
  parsedTrace: ParsedAndroidCrashTrace | null,
): string {
  const fromTrace = parsedTrace?.exceptionMessage?.trim();
  if (fromTrace) {
    return fromTrace;
  }

  const fromDescription = crash.description?.trim();
  if (fromDescription) {
    return fromDescription;
  }

  const fromType = parsedTrace?.exceptionType?.trim();
  if (fromType) {
    return fromType;
  }

  return buildFallbackCrashMessage(crash);
}

/** Flutter-aligned fallback when the trace carries no parseable message or type. */
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
