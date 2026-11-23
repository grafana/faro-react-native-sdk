/** Visible-only process CPU/memory events; all native reads are asynchronous. */
export interface PerformanceInstrumentationOptions {
  /** Emit app.memory in MB (RSS on Android, footprint on iOS). Default true. */
  memoryUsageVitals?: boolean;
  /** Emit app.cpu_usage as percent of available CPU time, including idle 0. Default true. */
  cpuUsageVitals?: boolean;
  /** Shared visible window in ms. Default 30000; non-positive/non-finite values use the default. */
  fetchVitalsInterval?: number;
}
