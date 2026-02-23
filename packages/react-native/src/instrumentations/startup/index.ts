import { AppState, NativeModules } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import type { StartupInstrumentationOptions } from './types';

const { FaroReactNativeModule } = NativeModules;

/**
 * Measures React Native app startup time for both cold and warm starts.
 *
 * Uses native OS APIs for cold start and AppState for warm start:
 * - iOS: sysctl() to query kernel for process start time
 * - Android: Process.getStartElapsedRealtime() from Android OS (API 24+)
 *
 * Implementation aligned with Faro Flutter SDK:
 * https://github.com/grafana/faro-flutter-sdk
 *
 * **Key Features**:
 * - ✅ NO AppDelegate/MainActivity setup required - OS tracks process start automatically!
 * - ✅ Cold start: appStartDuration from native, coldStart: 1
 * - ✅ Warm start: appStartDuration (time to first frame after resume), coldStart: 0
 *
 * **Metrics Captured** (matches Flutter SDK format):
 * - Cold start: `appStartDuration`, `coldStart: 1`
 * - Warm start: `appStartDuration`, `coldStart: 0`
 *
 * **Requirements**:
 * - iOS 13.4+ (any iOS that supports React Native)
 * - Android API 24+ (Android 7.0 Nougat, ~99% of devices as of 2025)
 *
 * @example
 * ```tsx
 * import { initializeFaro } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   app: { name: 'my-app', version: '1.0.0' },
 *   url: 'https://your-collector.com',
 * });
 * ```
 * StartupInstrumentation is included by default via makeRNConfig.
 */
export class StartupInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-startup';
  readonly version = VERSION;

  /** 0 = came from background (warm start eligible), null = never backgrounded */
  private warmStartTimestamp: number | null = null;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;

  constructor(private options: StartupInstrumentationOptions = {}) {
    super();
  }

  initialize(): void {
    if (this.options.enabled === false) {
      return;
    }

    this.captureColdStartMetrics();
    this.setupWarmStartTracking();
  }

  /**
   * Captures cold start duration from native (process start to Faro init).
   * Matches Flutter SDK: appStartDuration + coldStart: 1
   */
  private captureColdStartMetrics(): void {
    try {
      if (!FaroReactNativeModule?.getAppStartDuration) {
        this.logWarn(
          'Native module not available. Startup instrumentation requires native module. ' +
            'Run `cd ios && pod install` and rebuild the app.'
        );
        return;
      }

      const appStartDuration = FaroReactNativeModule.getAppStartDuration();

      if (appStartDuration === 0) {
        this.logWarn(
          'App startup duration is 0. This may indicate unsupported Android version (< API 24) ' +
            'or an issue with the native module.'
        );
        return;
      }

      const values: Record<string, number> = {
        appStartDuration,
        coldStart: 1,
      };

      setTimeout(() => {
        this.api.pushMeasurement(
          { type: 'app_startup', values },
          { skipDedupe: true }
        );
      }, 100);

      this.logInfo(`Cold start metrics captured: ${appStartDuration}ms`);
    } catch (error) {
      this.logError('Failed to capture cold start metrics', error);
    }
  }

  /**
   * Tracks warm start: when app resumes from background, measures time to first frame.
   * Matches Flutter SDK: setWarmStart on resume, getWarmStart after postFrameCallback.
   */
  private setupWarmStartTracking(): void {
    this.appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        this.warmStartTimestamp = 0; // Sentinel: next 'active' is a warm start
      } else if (nextAppState === 'active' && this.warmStartTimestamp === 0) {
        // Came from background: measure time from resume to first frame
        const resumeTimestamp = Date.now();
        this.warmStartTimestamp = null;

        requestAnimationFrame(() => {
          const appStartDuration = Date.now() - resumeTimestamp;
          if (appStartDuration > 0) {
            this.api.pushMeasurement(
              {
                type: 'app_startup',
                values: { appStartDuration, coldStart: 0 },
              },
              { skipDedupe: true }
            );
            this.logInfo(`Warm start metrics captured: ${appStartDuration}ms`);
          }
        });
      }
    });
  }

  unpatch(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = undefined;
      this.warmStartTimestamp = null;
    }
  }
}
