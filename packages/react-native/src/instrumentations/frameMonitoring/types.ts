/**
 * Configuration options for Frame Monitoring instrumentation.
 *
 * Frozen frame threshold (700ms).
 *
 * Note: To enable frame monitoring, set `refreshRateVitals: true` in ReactNativeConfig.
 */
export interface FrameMonitoringOptions {
  /**
   * Target frames per second for slow frame detection.
   * Frames rendering below this threshold are considered "slow".
   * Default: 60
   */
  targetFps?: number;

  /**
   * Threshold in milliseconds for detecting frozen frames.
   * Frames taking longer than this are considered "frozen".
   * Default: 700ms (Android Vitals and OpenTelemetry Android slow rendering instrumentation)
   */
  frozenFrameThresholdMs?: number;

  /**
   * Interval in milliseconds for polling and sending slow and frozen frame counts.
   * The name is historical: no refresh rate is collected or sent.
   * Default: 30000 (30 seconds)
   */
  refreshRatePollingInterval?: number;

  /**
   * Normalized frame rate for ProMotion displays (120Hz, etc.) on iOS.
   * iOS scales measured frame rates to this baseline before comparing them with `targetFps`
   * for slow frame detection. Default: 60
   */
  normalizedRefreshRate?: number;
}

/**
 * Frame metrics collected by the instrumentation.
 */
export interface FrameMetrics {
  /**
   * Number of slow frames since last measurement.
   */
  slowFrames: number;

  /**
   * Number of frozen frames since last measurement.
   */
  frozenFrames: number;

  /**
   * Total duration of frozen frames in milliseconds.
   */
  frozenDurationMs: number;
}

/**
 * Native module methods for frame monitoring.
 */
export interface FrameMonitoringNativeModule {
  /**
   * Start frame monitoring.
   */
  startFrameMonitoring(config: {
    targetFps: number;
    frozenFrameThresholdMs: number;
    normalizedRefreshRate: number;
  }): void;

  /**
   * Stop frame monitoring.
   */
  stopFrameMonitoring(): void;

  /**
   * Get current frame metrics.
   */
  getFrameMetrics(): Promise<FrameMetrics | null>;
}
