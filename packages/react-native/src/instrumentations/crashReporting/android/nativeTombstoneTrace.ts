/** Detect Android tombstone backtrace lines used for NDK native retrace. */
export function looksLikeNativeTombstoneTrace(trace: string | undefined): boolean {
  if (!trace?.trim()) {
    return false;
  }

  return trace.split('\n').some((line) => /^\s*#\d+\s+pc\s+(?:0x)?[0-9a-fA-F]+\s+\S+/i.test(line));
}
