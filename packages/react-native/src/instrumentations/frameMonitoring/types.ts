/**
 * Configuration options for Frame Monitoring instrumentation.
 *
 * These are React Native-specific advanced options. Most defaults align with the Flutter SDK;
 * frozen frame threshold follows Android Vitals / OpenTelemetry Android (700ms).
 *
 * Note: To enable frame monitoring, set `refreshRateVitals: true` in ReactNativeConfig.
 */
export interface FrameMonitoringOptions {
  /**
   * Target frames per second for slow frame detection.
   * Frames rendering below this threshold are considered "slow".
   * Default: 60 (Flutter SDK hardcoded value)
   */
  targetFps?: number;

  /**
   * Threshold in milliseconds for detecting frozen frames.
   * Frames taking longer than this are considered "frozen".
   * Default: 700ms (Android Vitals and OpenTelemetry Android slow rendering instrumentation)
   */
  frozenFrameThresholdMs?: number;

  /**
   * Interval in milliseconds for collecting and sending frame metrics.
   * Default: 30000 (30 seconds, aligned with fetchVitalsInterval)
   */
  refreshRatePollingInterval?: number;

  /**
   * Normalized refresh rate for ProMotion displays (120Hz, etc.).
   * Used to normalize frame rates for high-refresh-rate displays to a standard baseline.
   * Default: 60 (Flutter SDK's backendSupportedFrameRate)
   */
  normalizedRefreshRate?: number;
}

/**
 * Frame metrics collected by the instrumentation.
 */
export interface FrameMetrics {
  /**
   * Current refresh rate in FPS.
   */
  refreshRate: number;

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

  /**
   * Get current refresh rate.
   */
  getRefreshRate(): Promise<number | null>;
}
