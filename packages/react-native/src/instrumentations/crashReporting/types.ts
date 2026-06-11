/**
 * Crash report data structure returned from native module.
 */
export interface CrashReport {
  trace?: string;
  signal?: string;
  timestamp?: number;
  description?: string;
  processName?: string;
  pid?: number;
  importance?: number;
  // iOS-specific fields
  reason?: string; // Signal name (e.g., 'SIGSEGV')
  status?: number; // Exit status code
}

/**
 * Configuration options for crash reporting instrumentation.
 */
export interface CrashReportingOptions {
  /**
   * Enable or disable crash reporting. Defaults to true.
   */
  enabled?: boolean;

  /**
   * Optional release bundle filename hint for R8 retracing.
   * e.g., "index.android.bundle"
   */
  releaseBundleFilename?: string;
}
