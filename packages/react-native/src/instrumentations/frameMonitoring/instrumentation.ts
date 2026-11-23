import { NativeModules } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import type { API } from '@grafana/faro-core';

import type { FrameMetrics, FrameMonitoringOptions } from './types';

/**
 * Default configuration values. Frozen frame threshold aligns with Android Vitals
 * and OpenTelemetry Android slow rendering instrumentation (700ms).
 */
const DEFAULT_TARGET_FPS = 60;
const DEFAULT_FROZEN_FRAME_THRESHOLD_MS = 700;
const DEFAULT_REFRESH_RATE_POLLING_INTERVAL = 30000;
const DEFAULT_NORMALIZED_REFRESH_RATE = 60;

/**
 * Frame Monitoring Instrumentation for React Native.
 *
 * Monitors frame rendering performance and detects slow/frozen frames.
 * Uses native CADisplayLink (iOS) and Choreographer (Android) for accurate metrics.
 * `getRNInstrumentations()` adds it when `refreshRateVitals: true`. It reports slow and frozen
 * frames only, not a refresh rate.
 * The native monitor has one owner per process. Remove an instance from its old
 * Faro before registering it with another; do not share it between active Faros.
 *
 * ## Slow Frame Detection
 * Slow frames are detected using **event-based grouping** to report user-perceptible jank:
 * - Tracks consecutive frames below `targetFps` as a single "slow frame event"
 * - Only counts events lasting ≥50ms (~3 frames at 60fps) to filter noise
 * - This prevents reporting normal microsecond variations as slow frames
 * - Reports meaningful performance degradation that affects user experience
 *
 * ## Frozen Frame Detection
 * Frozen frames are individual frames exceeding `frozenFrameThresholdMs` (default 700ms).
 * These represent severe jank where the app appears unresponsive.
 *
 * Sends measurements via Faro API:
 * - `app_frames_rate`: Number of slow frame events (not individual frames)
 * - `app_frozen_frame`: Number of frozen frames (exceeding frozenFrameThresholdMs)
 *
 * @example
 * ```typescript
 * import { initializeFaro, FrameMonitoringInstrumentation } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   url: 'https://collector.example.com',
 *   instrumentations: [
 *     new FrameMonitoringInstrumentation({
 *       targetFps: 60,
 *       frozenFrameThresholdMs: 700,
 *       refreshRatePollingInterval: 30000,
 *     }),
 *   ],
 * });
 * ```
 */
export class FrameMonitoringInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-frame-monitoring';
  readonly version = VERSION;

  private readonly options: Required<FrameMonitoringOptions>;
  private pollingIntervalId: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private initializedApi: API | undefined;
  private nativeModule: typeof NativeModules.FaroReactNativeModule | null = null;

  constructor(options: FrameMonitoringOptions = {}) {
    super();
    this.options = {
      targetFps: options.targetFps ?? DEFAULT_TARGET_FPS,
      frozenFrameThresholdMs: options.frozenFrameThresholdMs ?? DEFAULT_FROZEN_FRAME_THRESHOLD_MS,
      refreshRatePollingInterval: options.refreshRatePollingInterval ?? DEFAULT_REFRESH_RATE_POLLING_INTERVAL,
      normalizedRefreshRate: options.normalizedRefreshRate ?? DEFAULT_NORMALIZED_REFRESH_RATE,
    };
  }

  initialize(): void {
    if (this.nativeModule !== null) {
      if (this.initializedApi === this.api) {
        return;
      }
      this.unpatch();
    }
    this.logDebug('Initializing frame monitoring instrumentation');

    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      this.logWarn('Native module not available for frame monitoring');
      return;
    }

    this.nativeModule = nativeModule;
    this.initializedApi = this.api;

    // Start native frame monitoring with configuration
    this.startNativeMonitoring(nativeModule);

    // Slow and frozen frames are polled on both platforms
    this.startPolling();
  }

  private getNativeModule(): typeof NativeModules.FaroReactNativeModule | null {
    const { FaroReactNativeModule } = NativeModules;

    if (!FaroReactNativeModule) {
      return null;
    }

    return FaroReactNativeModule;
  }

  private startNativeMonitoring(nativeModule: typeof NativeModules.FaroReactNativeModule): void {
    try {
      if (typeof nativeModule.startFrameMonitoring === 'function') {
        nativeModule.startFrameMonitoring({
          targetFps: this.options.targetFps,
          frozenFrameThresholdMs: this.options.frozenFrameThresholdMs,
          normalizedRefreshRate: this.options.normalizedRefreshRate,
        });
        this.logDebug('Started native frame monitoring');
      }
    } catch (error) {
      this.logError('Failed to start native frame monitoring', error);
    }
  }

  private startPolling(): void {
    const generation = this.generation;
    // Both iOS and Android use polling for slow and frozen frames (avoids duplicate reports on Android).
    this.pollingIntervalId = setInterval(() => {
      this.pollFrameMetrics(generation);
    }, this.options.refreshRatePollingInterval);
  }

  private isCurrent(generation: number): boolean {
    return this.nativeModule !== null && generation === this.generation;
  }

  private async pollFrameMetrics(generation: number): Promise<void> {
    const nativeModule = this.nativeModule;
    if (!nativeModule || !this.isCurrent(generation)) {
      return;
    }

    try {
      if (typeof nativeModule.getFrameMetrics === 'function') {
        const metrics = (await nativeModule.getFrameMetrics()) as FrameMetrics | null;
        if (!this.isCurrent(generation)) {
          return;
        }
        if (metrics) {
          if (metrics.slowFrames > 0) {
            this.handleSlowFrames(metrics.slowFrames);
          }
          if (this.isCurrent(generation) && metrics.frozenFrames > 0) {
            this.handleFrozenFrame(metrics.frozenFrames, metrics.frozenDurationMs);
          }
        }
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.logError('Failed to poll frame metrics', error);
      }
    }
  }

  private handleSlowFrames(count: number): void {
    // Note: Despite the name "slow_frames", this count represents slow frame EVENTS, not individual frames.
    // Each event is a period of consecutive slow frames lasting ≥50ms (~3 frames at 60fps).
    this.api.pushMeasurement(
      {
        type: 'app_frames_rate',
        values: { slow_frames: count },
      },
      { skipDedupe: true }
    );
  }

  private handleFrozenFrame(count: number, durationMs: number): void {
    if (durationMs > 0) {
      this.api.pushMeasurement(
        {
          type: 'app_frozen_frame',
          values: {
            frozen_frames: count,
            frozen_duration: durationMs,
          },
        },
        { skipDedupe: true }
      );
    }
  }

  /**
   * Clean up resources when instrumentation is disabled.
   */
  unpatch(): void {
    const nativeModule = this.nativeModule;
    this.nativeModule = null;
    this.initializedApi = undefined;
    this.generation++;
    // Stop polling
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }

    // Stop native monitoring
    if (nativeModule && typeof nativeModule.stopFrameMonitoring === 'function') {
      try {
        nativeModule.stopFrameMonitoring();
      } catch (error) {
        this.logError('Failed to stop native frame monitoring', error);
      }
    }

    this.logDebug('Frame monitoring instrumentation stopped');
  }

  destroy(): void {
    this.unpatch();
  }
}
