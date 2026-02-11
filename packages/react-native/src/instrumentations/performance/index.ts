import { NativeModules } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import type { PerformanceInstrumentationOptions } from './types';

// Log at module load time to see when this happens
console.log('[PERF DEBUG] ========== Module Load Time ==========');
console.log('[PERF DEBUG] NativeModules:', Object.keys(NativeModules || {}).join(', '));
console.log(`[PERF DEBUG] FaroReactNativeModule at module load: ${!!NativeModules['FaroReactNativeModule']}`);

const { FaroReactNativeModule } = NativeModules;

console.log(`[PERF DEBUG] FaroReactNativeModule destructured: ${!!FaroReactNativeModule}`);
if (FaroReactNativeModule) {
  console.log('[PERF DEBUG] FaroReactNativeModule methods:', Object.keys(FaroReactNativeModule).join(', '));
}

/**
 * Measures React Native app performance metrics (CPU and Memory usage)
 *
 * Collects periodic performance metrics using native OS APIs:
 * - iOS: task_info() for memory, host_statistics() for CPU
 * - Android: /proc/[pid]/status for memory, /proc/[pid]/stat for CPU
 *
 * Implementation ported from Faro Flutter SDK with feature parity.
 *
 * **Key Features**:
 * - ✅ NO manual setup required - OS tracks metrics automatically!
 * - ✅ Periodic collection (default: every 30 seconds)
 * - ✅ Configurable per-metric enable/disable
 * - ✅ Differential CPU calculation (accurate usage percentages)
 * - ✅ Memory usage in KB (Resident Set Size)
 *
 * **Metrics Captured**:
 * - `mem_usage`: Current memory usage in KB (RSS - physical memory)
 * - `cpu_usage`: Current CPU usage percentage (0-100+)
 *
 * **Requirements**:
 * - iOS 13.4+ (any iOS that supports React Native)
 * - Android API 21+ for CPU (Android 5.0 Lollipop, ~99% of devices)
 * - Android any version for Memory
 *
 * @example
 * ```tsx
 * import { initializeFaro, getRNInstrumentations } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   url: 'https://your-collector.com',
 *   instrumentations: [
 *     ...getRNInstrumentations({
 *       memoryUsageVitals: true,      // default: true
 *       cpuUsageVitals: true,          // default: true
 *       fetchVitalsInterval: 30000,    // default: 30s
 *     }),
 *   ],
 * });
 * ```
 */
export class PerformanceInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-performance';
  readonly version = VERSION;

  private options: Required<PerformanceInstrumentationOptions>;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: PerformanceInstrumentationOptions = {}) {
    super();
    console.log('[PERF DEBUG] PerformanceInstrumentation constructor called');
    console.log(`[PERF DEBUG] Input options: memoryUsageVitals=${options.memoryUsageVitals}, cpuUsageVitals=${options.cpuUsageVitals}, fetchVitalsInterval=${options.fetchVitalsInterval}`);
    this.options = {
      memoryUsageVitals: options.memoryUsageVitals ?? true,
      cpuUsageVitals: options.cpuUsageVitals ?? true,
      fetchVitalsInterval: options.fetchVitalsInterval ?? 30000,
    };
    console.log(`[PERF DEBUG] Resolved options: memoryUsageVitals=${this.options.memoryUsageVitals}, cpuUsageVitals=${this.options.cpuUsageVitals}, fetchVitalsInterval=${this.options.fetchVitalsInterval}`);
  }

  initialize(): void {
    console.log('[PERF DEBUG] =========================================');
    console.log('[PERF DEBUG] PerformanceInstrumentation.initialize() called');
    console.log(`[PERF DEBUG] Options: memory=${this.options.memoryUsageVitals}, cpu=${this.options.cpuUsageVitals}, interval=${this.options.fetchVitalsInterval}`);
    console.log(`[PERF DEBUG] FaroReactNativeModule available: ${!!FaroReactNativeModule}`);
    console.log(`[PERF DEBUG] this.api available: ${!!this.api}`);
    console.log(`[PERF DEBUG] this.api.pushMeasurement available: ${!!this.api?.pushMeasurement}`);

    this.logDebug(`PerformanceInstrumentation.initialize() called`);
    this.logDebug(`Options: memory=${this.options.memoryUsageVitals}, cpu=${this.options.cpuUsageVitals}, interval=${this.options.fetchVitalsInterval}`);
    this.logDebug(`FaroReactNativeModule available: ${!!FaroReactNativeModule}`);

    // Only start if at least one metric is enabled
    if (!this.options.memoryUsageVitals && !this.options.cpuUsageVitals) {
      console.log('[PERF DEBUG] Both metrics disabled - returning early');
      this.logInfo('Performance monitoring disabled - no metrics enabled');
      return;
    }

    // Check native module availability
    if (!FaroReactNativeModule) {
      console.log('[PERF DEBUG] Native module NOT available - returning early');
      this.logWarn(
        'Native module not available. Performance instrumentation requires native module. ' +
          'Run `cd ios && pod install` and rebuild the app.'
      );
      return;
    }

    console.log('[PERF DEBUG] All checks passed, calling startPeriodicCollection()');
    // Start periodic collection
    this.startPeriodicCollection();
    console.log('[PERF DEBUG] startPeriodicCollection() completed');
  }

  private startPeriodicCollection(): void {
    console.log('[PERF DEBUG] startPeriodicCollection() called');

    // Collect immediately on initialization
    console.log('[PERF DEBUG] Calling collectMetrics() immediately...');
    this.collectMetrics();
    console.log('[PERF DEBUG] collectMetrics() first call completed');

    // Then collect periodically
    console.log(`[PERF DEBUG] Setting up interval for ${this.options.fetchVitalsInterval}ms`);
    this.intervalId = setInterval(() => {
      console.log('[PERF DEBUG] Interval tick - collecting metrics...');
      this.collectMetrics();
    }, this.options.fetchVitalsInterval);

    console.log('[PERF DEBUG] Interval set up successfully');
    this.logInfo(
      `Performance monitoring started - collecting every ${this.options.fetchVitalsInterval}ms ` +
        `(memory: ${this.options.memoryUsageVitals}, cpu: ${this.options.cpuUsageVitals})`
    );
  }

  private collectMetrics(): void {
    console.log('[PERF DEBUG] collectMetrics() called');
    console.log(`[PERF DEBUG] memoryUsageVitals=${this.options.memoryUsageVitals}, cpuUsageVitals=${this.options.cpuUsageVitals}`);

    // Collect memory if enabled
    if (this.options.memoryUsageVitals) {
      console.log('[PERF DEBUG] Calling collectMemoryUsage()...');
      this.collectMemoryUsage();
      console.log('[PERF DEBUG] collectMemoryUsage() completed');
    }

    // Collect CPU if enabled
    if (this.options.cpuUsageVitals) {
      console.log('[PERF DEBUG] Calling collectCpuUsage()...');
      this.collectCpuUsage();
      console.log('[PERF DEBUG] collectCpuUsage() completed');
    }

    console.log('[PERF DEBUG] collectMetrics() completed');
  }

  private collectMemoryUsage(): void {
    console.log('[PERF DEBUG] collectMemoryUsage() called');
    try {
      console.log(`[PERF DEBUG] FaroReactNativeModule?.getMemoryUsage available: ${!!FaroReactNativeModule?.getMemoryUsage}`);
      if (!FaroReactNativeModule?.getMemoryUsage) {
        console.log('[PERF DEBUG] Memory: getMemoryUsage not available - returning');
        this.logDebug('Memory: getMemoryUsage not available on native module');
        return;
      }

      console.log('[PERF DEBUG] Calling FaroReactNativeModule.getMemoryUsage()...');
      const memoryUsage = FaroReactNativeModule.getMemoryUsage();
      console.log(`[PERF DEBUG] Memory: raw value = ${memoryUsage}, type = ${typeof memoryUsage}`);
      this.logDebug(`Memory: raw value = ${memoryUsage}`);

      if (memoryUsage == null || memoryUsage <= 0) {
        console.log('[PERF DEBUG] Memory: skipping - value is null or <= 0');
        this.logDebug('Memory: skipping - value is null or <= 0');
        return;
      }

      console.log(`[PERF DEBUG] Memory: about to call this.api.pushMeasurement with mem_usage = ${memoryUsage}`);
      console.log(`[PERF DEBUG] this.api = ${!!this.api}, this.api.pushMeasurement = ${!!this.api?.pushMeasurement}`);
      this.logDebug(`Memory: pushing measurement with mem_usage = ${memoryUsage}`);
      this.api.pushMeasurement(
        {
          type: 'app_memory',
          values: {
            mem_usage: memoryUsage,
          },
        },
        {
          skipDedupe: true,
        }
      );
      console.log('[PERF DEBUG] Memory: pushMeasurement call completed successfully');
    } catch (error) {
      console.log('[PERF DEBUG] Memory: EXCEPTION caught:', error);
      this.logError('Failed to collect memory usage', error);
    }
  }

  private collectCpuUsage(): void {
    console.log('[PERF DEBUG] collectCpuUsage() called');
    try {
      console.log(`[PERF DEBUG] FaroReactNativeModule?.getCpuUsage available: ${!!FaroReactNativeModule?.getCpuUsage}`);
      if (!FaroReactNativeModule?.getCpuUsage) {
        console.log('[PERF DEBUG] CPU: getCpuUsage not available - returning');
        this.logDebug('CPU: getCpuUsage not available on native module');
        return;
      }

      console.log('[PERF DEBUG] Calling FaroReactNativeModule.getCpuUsage()...');
      const cpuUsage = FaroReactNativeModule.getCpuUsage();
      console.log(`[PERF DEBUG] CPU: raw value = ${cpuUsage}, type = ${typeof cpuUsage}`);
      this.logDebug(`CPU: raw value = ${cpuUsage}`);

      // Validate CPU usage (Flutter SDK filters 0-100 range, but allows >100)
      // Skip null, negative, or exactly 0 (baseline reading)
      if (cpuUsage == null || cpuUsage <= 0) {
        console.log('[PERF DEBUG] CPU: skipping - value is null or <= 0');
        this.logDebug('CPU: skipping - value is null or <= 0');
        return;
      }

      console.log(`[PERF DEBUG] CPU: about to call this.api.pushMeasurement with cpu_usage = ${cpuUsage}`);
      console.log(`[PERF DEBUG] this.api = ${!!this.api}, this.api.pushMeasurement = ${!!this.api?.pushMeasurement}`);
      this.logDebug(`CPU: pushing measurement with cpu_usage = ${cpuUsage}`);
      // Flutter SDK also filters values >= 100, but we allow them as they can be valid
      // in multi-core scenarios where one core is maxed out
      this.api.pushMeasurement(
        {
          type: 'app_cpu_usage',
          values: {
            cpu_usage: cpuUsage,
          },
        },
        {
          skipDedupe: true,
        }
      );
      console.log('[PERF DEBUG] CPU: pushMeasurement call completed successfully');
    } catch (error) {
      console.log('[PERF DEBUG] CPU: EXCEPTION caught:', error);
      this.logError('Failed to collect CPU usage', error);
    }
  }

  unpatch(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logInfo('Performance monitoring stopped');
    }
  }
}
