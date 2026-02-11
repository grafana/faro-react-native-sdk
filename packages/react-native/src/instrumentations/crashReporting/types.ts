/**
 * Configuration options for Crash Reporting instrumentation.
 *
 * **Note**: This is an experimental feature. Crash reporting uses:
 * - Android: ApplicationExitInfo API (Android 11+)
 * - iOS: PLCrashReporter (requires adding the dependency)
 */
export interface CrashReportingOptions {
  /**
   * Whether to enable crash reporting.
   * Default: true
   */
  enabled?: boolean;
}

/**
 * Crash report data from native module.
 */
export interface CrashReport {
  /**
   * Type of crash (e.g., "CRASH", "CRASH_NATIVE", "ANR", "LOW_MEMORY")
   */
  type: string;

  /**
   * Timestamp when the crash occurred (milliseconds since epoch)
   */
  timestamp: number;

  /**
   * Human-readable timestamp
   */
  timestamp_readable_utc?: string;

  /**
   * Exit status code
   */
  status?: number;

  /**
   * Description of the crash
   */
  description?: string;

  /**
   * Process importance level
   */
  importance?: number;

  /**
   * Process ID
   */
  pid?: number;

  /**
   * Process name
   */
  processName?: string;

  /**
   * Stack trace (if available)
   */
  stacktrace?: string;

  /**
   * Signal name (for iOS crashes)
   */
  signal?: string;
}
