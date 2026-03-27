/**
 * Configuration options for ANR (Application Not Responding) detection.
 */
export interface ANRInstrumentationOptions {
  /**
   * Timeout in milliseconds for detecting ANR.
   * If the main thread doesn't respond within this time, an ANR is recorded.
   * Default: 5000 (5 seconds, matching Android's ANR threshold)
   */
  timeout?: number;

  /**
   * Interval in milliseconds for polling ANR status from native.
   * Default: 60000 (60 seconds, matching Flutter SDK's default)
   */
  pollingInterval?: number;
}

/**
 * ANR event data from native module.
 */
export interface ANREvent {
  /**
   * Event type (always "ANR")
   */
  type: string;

  /**
   * Timestamp when ANR was detected
   */
  timestamp: number;

  /**
   * Stack trace of the main thread when ANR was detected
   */
  stacktrace: string;

  /**
   * Duration of the ANR in milliseconds
   */
  duration: number;
}
