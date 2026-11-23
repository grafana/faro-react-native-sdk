import { AppState, NativeModules, Platform } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import { bytesToMb, cpuUtilization, formatCpuPercent } from './processUsage';
import type { PerformanceNativeModule, PerformanceSnapshot } from './processUsage';
import type { PerformanceInstrumentationOptions } from './types';

const MAX_READ_TIMEOUT_MS = 10000;

/**
 * Emits app.cpu_usage (process utilization, percent) and app.memory (RSS/footprint, MB).
 * Native reads return promises and run off the UI thread. One shared timer ends each
 * visible window (30s by default); memory is also read 2s after visibility/start.
 * Sequential ticks subtract native/bridge read latency from the next delay.
 * iOS inactive remains visible. Unknown/extension/null wait for known visibility.
 * Hidden and stale windows are discarded. A >2x-interval window sends memory but no CPU.
 * Short visits have no CPU sample.
 * A native read that does not settle within min(interval, 10s) counts as failed.
 */
export class PerformanceInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-performance';
  readonly version = VERSION;
  private readonly options: Required<PerformanceInstrumentationOptions>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private memoryTimer: ReturnType<typeof setTimeout> | undefined;
  private subscription: { remove(): void } | undefined;
  private running = false;
  private subscriptionToken = 0;
  private generation = 0;
  private visible = false;
  private baseline: PerformanceSnapshot | undefined;

  constructor(options: PerformanceInstrumentationOptions = {}) {
    super();
    const interval = options.fetchVitalsInterval ?? 30000;
    this.options = {
      cpuUsageVitals: options.cpuUsageVitals ?? true,
      memoryUsageVitals: options.memoryUsageVitals ?? true,
      fetchVitalsInterval: Number.isFinite(interval) && interval > 0 ? interval : 30000,
    };
  }

  initialize(): void {
    this.unpatch();
    if (
      (!this.options.cpuUsageVitals && !this.options.memoryUsageVitals) ||
      typeof NativeModules['FaroReactNativeModule']?.getPerformanceSnapshot !== 'function'
    ) {
      this.logDebug('Performance snapshot native API unavailable or vitals disabled');
      return;
    }
    this.running = true;
    const token = this.subscriptionToken;
    this.subscription = AppState.addEventListener('change', (state) => {
      if (this.running && token === this.subscriptionToken) {
        this.updateVisibility(state);
      }
    });
    this.updateVisibility(AppState.currentState);
  }

  private updateVisibility(state: string | null | undefined): void {
    const visible = state === 'active' || (Platform.OS === 'ios' && state === 'inactive');
    if (visible === this.visible) {
      return;
    }
    this.stopWindow();
    this.visible = visible;
    if (visible) {
      const generation = this.generation;
      void this.tick(generation);
      if (this.options.memoryUsageVitals) {
        this.memoryTimer = setTimeout(() => {
          void this.readVisibleMemory(generation);
        }, 2000);
      }
    }
  }

  private current(generation: number): boolean {
    return this.running && this.visible && generation === this.generation;
  }

  /**
   * Reads a native snapshot. A read that does not settle within the interval, at most
   * 10 s, rejects so a lost reply cannot stall sampling; a late reply is ignored.
   */
  private snapshot(cpu: boolean, memory: boolean): Promise<PerformanceSnapshot> {
    const native: PerformanceNativeModule = NativeModules['FaroReactNativeModule'];
    const timeoutMs = Math.min(this.options.fetchVitalsInterval, MAX_READ_TIMEOUT_MS);
    return new Promise<PerformanceSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Performance snapshot timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve()
        .then(() => native.getPerformanceSnapshot(cpu, memory))
        .then(
          (snapshot) => {
            clearTimeout(timeout);
            resolve(snapshot);
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
    });
  }

  private emitMemory(snapshot: PerformanceSnapshot): void {
    const value = bytesToMb(snapshot.memoryBytes);
    if (value === null) {
      return;
    }
    this.api.pushEvent(
      'app.memory',
      {
        value,
        unit: 'MB',
        'memory.basis': Platform.OS === 'android' ? 'rss' : 'phys_footprint',
      },
      undefined,
      { timestampOverwriteMs: snapshot.timestampMs, skipDedupe: true }
    );
  }

  private async readVisibleMemory(generation: number): Promise<void> {
    if (!this.current(generation)) {
      return;
    }
    try {
      const snapshot = await this.snapshot(false, true);
      if (this.current(generation)) {
        this.emitMemory(snapshot);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.logDebug('Memory read failed', error);
      }
    }
  }

  private async tick(generation: number): Promise<void> {
    if (!this.current(generation)) {
      return;
    }
    const dispatchedAt = this.now();
    let readLatency = 0;
    try {
      const start = this.baseline;
      const end = await this.snapshot(this.options.cpuUsageVitals, !!start && this.options.memoryUsageVitals);
      if (!this.current(generation)) {
        return;
      }
      readLatency = Math.max(0, this.now() - dispatchedAt);
      this.baseline = end;
      if (start) {
        const elapsed = end.elapsedMs - start.elapsedMs;
        // A window over 2x the interval (stalled timer or blocked JS thread) has no usable CPU value.
        // The memory reading is still a valid sample of this moment, so it is sent either way.
        if (Number.isFinite(elapsed) && elapsed > 0 && elapsed <= 2 * this.options.fetchVitalsInterval) {
          const value = cpuUtilization(start, end);
          if (this.options.cpuUsageVitals && value !== null) {
            this.api.pushEvent(
              'app.cpu_usage',
              {
                value: formatCpuPercent(value),
                unit: 'percent',
                'cpu.logical_count': String(end.logicalCount),
                window_ms: String(Math.round(elapsed)),
                'cpu.basis': 'process_utilization',
              },
              undefined,
              { timestampOverwriteMs: end.timestampMs, skipDedupe: true }
            );
          }
        }
        if (this.options.memoryUsageVitals && this.current(generation)) {
          this.emitMemory(end);
        }
      }
    } catch (error) {
      if (this.current(generation)) {
        this.baseline = undefined;
        this.logDebug('Performance read failed', error);
      }
    }
    if (this.current(generation)) {
      this.timer = setTimeout(
        () => {
          void this.tick(generation);
        },
        Math.max(0, this.options.fetchVitalsInterval - readLatency)
      );
    }
  }

  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  private stopWindow(): void {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.memoryTimer);
    this.baseline = undefined;
  }

  unpatch(): void {
    this.running = false;
    this.subscriptionToken++;
    this.stopWindow();
    this.visible = false;
    const subscription = this.subscription;
    this.subscription = undefined;
    try {
      subscription?.remove();
    } catch (error) {
      this.logDebug('Performance AppState cleanup failed', error);
    }
  }

  destroy(): void {
    this.unpatch();
  }
}
