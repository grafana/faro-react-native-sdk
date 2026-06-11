/**
 * Returns true when an ANR stack was sampled on the crash-killer path instead of
 * the blocked main thread (common when ANRTracker fires during process teardown).
 *
 * Uses only Android framework and Faro SDK frame names — no app-specific identifiers.
 */
export function isInvalidAnrCaptureStack(stack: string | undefined): boolean {
  if (!stack?.trim()) {
    return true;
  }

  const normalized = stack.toLowerCase();

  return (
    normalized.includes('handleapplicationcrash') ||
    normalized.includes('killapplicationhandler') ||
    normalized.includes('farouncaughtexceptionhandler')
  );
}
