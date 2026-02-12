/**
 * Configuration options for Crash Reporting instrumentation.
 *
 * **Platform Support**:
 * - **Android**: Uses ApplicationExitInfo API (Android 11+ / API 30+)
 *   Captures: CRASH, CRASH_NATIVE, ANR, LOW_MEMORY, EXCESSIVE_RESOURCE_USAGE
 * - **iOS**: Uses PLCrashReporter (automatically included via podspec)
 *   Captures: Signal crashes (SIGSEGV, SIGABRT, etc.) and Mach exceptions
 *
 * **Session Correlation**:
 * Both platforms persist the session ID to native storage (SharedPreferences/UserDefaults)
 * so crash reports include `crashedSessionId` for correlation in Grafana.
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
 *
 * Field names match Faro Flutter SDK for consistency across mobile platforms.
 * Both Android (ApplicationExitInfo) and iOS (PLCrashReporter) produce JSON
 * matching this interface.
 */
export interface CrashReport {
  /**
   * Reason for the crash (e.g., "CRASH", "CRASH_NATIVE", "ANR", "LOW_MEMORY")
   */
  reason: string;

  /**
   * Timestamp when the crash occurred (milliseconds since epoch)
   */
  timestamp: number;

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
  trace?: string;

  /**
   * Signal name (for iOS crashes)
   */
  signal?: string;

  /**
   * The Faro session ID that was active when the crash occurred.
   *
   * This enables correlation in Grafana dashboards - you can query events
   * from the session where the crash happened, not just the session where
   * it was reported.
   */
  crashedSessionId?: string;
}
