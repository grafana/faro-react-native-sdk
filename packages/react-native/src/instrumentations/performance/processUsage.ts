/** Raw process counters read on a native background queue. All times are milliseconds. */
export interface PerformanceSnapshot {
  cpuTimeMs: number | null;
  elapsedMs: number;
  logicalCount: number;
  timestampMs: number;
  memoryBytes: number | null;
}

/** Process utilization across available logical CPUs; invalid windows are never clamped. */
export function cpuUtilization(start: PerformanceSnapshot, end: PerformanceSnapshot): number | null {
  const elapsed = end.elapsedMs - start.elapsedMs;
  if (
    start.cpuTimeMs == null ||
    end.cpuTimeMs == null ||
    !Number.isFinite(elapsed) ||
    elapsed <= 0 ||
    !Number.isInteger(end.logicalCount) ||
    end.logicalCount <= 0
  ) {
    return null;
  }
  const value = (100 * (end.cpuTimeMs - start.cpuTimeMs)) / (elapsed * end.logicalCount);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** Decimal percent string with at most two decimal places. */
export function formatCpuPercent(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** MB string (1 MB = 1,048,576 bytes), or null for an unavailable reading. */
export function bytesToMb(bytes: number | null): string | null {
  return bytes != null && Number.isFinite(bytes) && bytes > 0 ? String(Number((bytes / 1048576).toFixed(1))) : null;
}

export interface PerformanceNativeModule {
  getPerformanceSnapshot(cpu: boolean, memory: boolean): Promise<PerformanceSnapshot>;
}
