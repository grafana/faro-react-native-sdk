import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { ReactNativeConfig } from '../../config/types';

import type { FrameMetrics, FrameMonitoringOptions } from './types';

/**
 * Default configuration values matching Flutter SDK's hardcoded values.
 * These are React Native-specific advanced options for customization.
 */
const DEFAULT_TARGET_FPS = 60;
const DEFAULT_FROZEN_FRAME_THRESHOLD_MS = 100;
const DEFAULT_REFRESH_RATE_POLLING_INTERVAL = 30000;
const DEFAULT_NORMALIZED_REFRESH_RATE = 60;

/**
 * Frame Monitoring Instrumentation for React Native.
 *
 * Monitors frame rendering performance and detects slow/frozen frames.
 * Uses native CADisplayLink (iOS) and Choreographer (Android) for accurate metrics.
 *
 * Sends measurements via Faro API:
 * - `app_refresh_rate`: Current refresh rate in FPS
 * - `app_frames_rate`: Number of slow frames (below targetFps)
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
 *       frozenFrameThresholdMs: 100,
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
  private eventEmitter: NativeEventEmitter | null = null;
  private eventSubscriptions: Array<{ remove: () => void }> = [];

  constructor(options: FrameMonitoringOptions = {}) {
    super();
    this.options = {
      targetFps: options.targetFps ?? DEFAULT_TARGET_FPS,
      frozenFrameThresholdMs: options.frozenFrameThresholdMs ?? DEFAULT_FROZEN_FRAME_THRESHOLD_MS,
      refreshRatePollingInterval: options.refreshRatePollingInterval ?? DEFAULT_REFRESH_RATE_POLLING_INTERVAL,
      normalizedRefreshRate: options.normalizedRefreshRate ?? DEFAULT_NORMALIZED_REFRESH_RATE,
    };
  }

  /**
   * Check if refresh rate vitals are enabled in Faro config.
   * Reads from faro.config.refreshRateVitals (single source of truth).
   */
  private get refreshRateVitalsEnabled(): boolean {
    // Access config via this.config which is set by BaseInstrumentation after initialization
    const config = this.config as ReactNativeConfig | undefined;
    return config?.refreshRateVitals ?? false;
  }

  initialize(): void {
    this.logDebug('Initializing frame monitoring instrumentation');

    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      this.logWarn('Native module not available for frame monitoring');
      return;
    }

    // Start native frame monitoring with configuration
    this.startNativeMonitoring(nativeModule);

    // Set up event listeners for real-time frame events (Android pattern)
    this.setupEventListeners(nativeModule);

    // Set up polling for periodic metrics collection (iOS pattern)
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

  private setupEventListeners(nativeModule: typeof NativeModules.FaroReactNativeModule): void {
    // Android uses event-based approach for frame drops
    if (Platform.OS === 'android') {
      try {
        this.eventEmitter = new NativeEventEmitter(nativeModule);

        // Listen for frozen frame events
        const frozenFrameSubscription = this.eventEmitter.addListener(
          'onFrozenFrame',
          (data: number | { count: number; durationMs: number }) => {
            // Support both formats: number (legacy) or object (with duration)
            if (typeof data === 'number') {
              this.handleFrozenFrame(data, 0);
            } else {
              this.handleFrozenFrame(data.count, data.durationMs || 0);
            }
          }
        );
        this.eventSubscriptions.push(frozenFrameSubscription);

        // Listen for slow frame events
        const slowFrameSubscription = this.eventEmitter.addListener('onSlowFrames', (count: number) => {
          this.handleSlowFrames(count);
        });
        this.eventSubscriptions.push(slowFrameSubscription);

        // Listen for refresh rate events (only when refreshRateVitals is enabled in config)
        if (this.refreshRateVitalsEnabled) {
          const refreshRateSubscription = this.eventEmitter.addListener('onRefreshRate', (refreshRate: number) => {
            this.handleRefreshRate(refreshRate);
          });
          this.eventSubscriptions.push(refreshRateSubscription);
        }

        this.logDebug('Set up Android frame event listeners');
      } catch (error) {
        this.logError('Failed to set up frame event listeners', error);
      }
    }
  }

  private startPolling(): void {
    // iOS uses polling approach
    if (Platform.OS === 'ios') {
      this.pollingIntervalId = setInterval(() => {
        this.pollFrameMetrics();
      }, this.options.refreshRatePollingInterval);
    }
  }

  private async pollFrameMetrics(): Promise<void> {
    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      return;
    }

    try {
      // Get refresh rate (only send when refreshRateVitals is enabled in config)
      if (this.refreshRateVitalsEnabled) {
        if (typeof nativeModule.getRefreshRate === 'function') {
          const refreshRate = await nativeModule.getRefreshRate();
          if (refreshRate !== null && refreshRate > 0) {
            this.handleRefreshRate(refreshRate);
          }
        }
      }

      // Get full frame metrics if available
      if (typeof nativeModule.getFrameMetrics === 'function') {
        const metrics = (await nativeModule.getFrameMetrics()) as FrameMetrics | null;
        if (metrics) {
          if (this.refreshRateVitalsEnabled && metrics.refreshRate > 0) {
            this.handleRefreshRate(metrics.refreshRate);
          }
          if (metrics.slowFrames > 0) {
            this.handleSlowFrames(metrics.slowFrames);
          }
          if (metrics.frozenFrames > 0) {
            this.handleFrozenFrame(metrics.frozenFrames, metrics.frozenDurationMs);
          }
        }
      }
    } catch (error) {
      this.logError('Failed to poll frame metrics', error);
    }
  }

  private handleRefreshRate(refreshRate: number): void {
    this.api.pushMeasurement(
      {
        type: 'app_refresh_rate',
        values: { refresh_rate: refreshRate },
      },
      { skipDedupe: true }
    );
  }

  private handleSlowFrames(count: number): void {
    this.api.pushMeasurement(
      {
        type: 'app_frames_rate',
        values: { slow_frames: count },
      },
      { skipDedupe: true }
    );
  }

  private handleFrozenFrame(count: number, durationMs: number): void {
    this.api.pushMeasurement(
      {
        type: 'app_frozen_frame',
        values: { 
          frozen_frames: count,
          frozen_duration: durationMs
        },
      },
      { skipDedupe: true }
    );
  }

  /**
   * Clean up resources when instrumentation is disabled.
   */
  unpatch(): void {
    // Stop polling
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }

    // Remove event subscriptions
    for (const subscription of this.eventSubscriptions) {
      subscription.remove();
    }
    this.eventSubscriptions = [];
    this.eventEmitter = null;

    // Stop native monitoring
    const nativeModule = this.getNativeModule();
    if (nativeModule && typeof nativeModule.stopFrameMonitoring === 'function') {
      try {
        nativeModule.stopFrameMonitoring();
      } catch (error) {
        this.logError('Failed to stop native frame monitoring', error);
      }
    }

    this.logDebug('Frame monitoring instrumentation stopped');
  }
}
