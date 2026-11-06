import { AppState } from 'react-native';

import { BaseTransport, VERSION } from '@grafana/faro-core';
import type { Patterns, Transport, TransportItem } from '@grafana/faro-core';

import { FetchTransport } from '../fetch';
import { groupItemsByMeta } from '../fetch/transport';

import { DefaultConnectivityService } from './ConnectivityService';
import { AsyncStorageOfflineCache } from './OfflineCache';
import type { CachedPayload, ConnectivityService, OfflineCache, OfflineTransportOptions } from './types';

/**
 * Default maximum cache duration: 3 days in milliseconds.
 */
const DEFAULT_MAX_CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * OfflineTransport - Caches telemetry when offline and replays when online.
 *
 * This transport wraps other transports and provides offline caching functionality.
 * When the device is offline, telemetry is cached to AsyncStorage.
 * When connectivity is restored, cached telemetry is replayed through the wrapped transports.
 *
 * Uses AsyncStorage for persistent offline telemetry caching.
 * - Respects maxCacheDuration to skip expired entries
 * - Uses mutex pattern for thread-safe cache access
 * - Excludes itself when replaying to prevent infinite loops
 *
 * @example
 * ```typescript
 * import { initializeFaro, FetchTransport, OfflineTransport } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   url: 'https://collector.example.com',
 *   transports: [
 *     new OfflineTransport({
 *       maxCacheDurationMs: 3 * 24 * 60 * 60 * 1000, // 3 days
 *     }),
 *     new FetchTransport({ url: 'https://collector.example.com' }),
 *   ],
 * });
 * ```
 */
export class OfflineTransport extends BaseTransport {
  readonly name = '@grafana/faro-react-native:transport-offline';
  readonly version = VERSION;

  private readonly cache: OfflineCache;
  private readonly connectivityService: ConnectivityService;
  private readonly maxCacheDurationMs: number;
  private getReplayTransports: () => Transport[] = () => [];
  private unsubscribeConnectivity: (() => void) | null = null;
  private isReplaying: boolean = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 1000;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  constructor(options: OfflineTransportOptions = {}) {
    super();

    this.maxCacheDurationMs = options.maxCacheDurationMs ?? DEFAULT_MAX_CACHE_DURATION_MS;

    this.cache = new AsyncStorageOfflineCache({
      storageKeyPrefix: options.storageKeyPrefix,
      maxCacheSize: options.maxCacheSize,
    });

    this.connectivityService = new DefaultConnectivityService(options.connectivityCheckIntervalMs);

    this.appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void this.forceReplay();
      } else {
        this.clearReplayRetry();
      }
    });

    // Subscribe to connectivity changes
    this.unsubscribeConnectivity = this.connectivityService.subscribe((isOnline) => {
      if (isOnline) {
        void this.forceReplay();
      } else {
        this.clearReplayRetry();
      }
    });
  }

  /**
   * Send telemetry items.
   *
   * When offline, items are cached for later replay.
   * When online, this transport does nothing (other transports handle sending).
   */
  async send(items: TransportItem | TransportItem[]): Promise<void> {
    const itemsArray = Array.isArray(items) ? items : [items];

    if (itemsArray.length === 0) {
      return;
    }

    if (!this.connectivityService.isOnline) {
      // Cache items when offline
      const payload: CachedPayload = {
        timestamp: Date.now(),
        items: itemsArray,
      };

      try {
        await this.cache.write(payload);
        this.logDebug(`Cached ${itemsArray.length} items for offline replay`);
      } catch (error) {
        this.logError('Failed to cache offline payload', error);
      }
    }
    // When online, do nothing - other transports handle sending
  }

  override getIgnoreUrls(): Patterns {
    return [];
  }

  override isBatched(): boolean {
    return true;
  }

  /**
   * Register other transports for replay.
   * The SDK supplies a live registry after initialization so pause and removal
   * take effect during replay. Manual registrations can supply a fixed list.
   */
  setOtherTransports(transports: Transport[] | (() => Transport[])): void {
    const registeredTransports = typeof transports === 'function' ? transports : [...transports];
    this.getReplayTransports = () => {
      const current = typeof registeredTransports === 'function' ? registeredTransports() : registeredTransports;
      return current.filter((transport) => !(transport instanceof OfflineTransport));
    };
  }

  /**
   * Get the current number of cached payloads.
   */
  async getCachedCount(): Promise<number> {
    return this.cache.getCount();
  }

  /**
   * Manually trigger replay of cached payloads.
   * Useful for testing or when you want to force a replay attempt.
   */
  async forceReplay(): Promise<void> {
    if (!this.disposed && this.connectivityService.isOnline) {
      await this.replayCachedPayloads();
    }
  }

  /**
   * Clear all cached payloads.
   */
  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.disposed = true;
    this.clearReplayRetry();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    if (this.unsubscribeConnectivity) {
      this.unsubscribeConnectivity();
      this.unsubscribeConnectivity = null;
    }
    this.connectivityService.dispose();
  }

  /**
   * Replay cached payloads through other transports.
   * Reads cached telemetry from AsyncStorage.
   */
  private async replayCachedPayloads(): Promise<void> {
    if (this.disposed || this.isReplaying) {
      return;
    }

    this.clearReplayRetry();
    this.isReplaying = true;
    let retryNeeded = false;

    try {
      const payloads = await this.cache.readAll();

      if (payloads.length === 0) {
        return;
      }

      this.logDebug(`Replaying ${payloads.length} cached payloads`);

      const now = Date.now();
      const successfulPayloads: CachedPayload[] = [];

      for (const payload of payloads) {
        // Skip expired payloads
        if (now - payload.timestamp > this.maxCacheDurationMs) {
          this.logDebug(`Skipping expired payload from ${new Date(payload.timestamp).toISOString()}`);
          successfulPayloads.push(payload);
          continue;
        }

        if (this.disposed || !this.connectivityService.isOnline) {
          continue;
        }

        const result = await this.sendToOtherTransports(payload.items);
        retryNeeded ||= result === 'retry';

        if (result === 'accepted') {
          successfulPayloads.push(payload);
        }
      }

      // Guard removal with the persisted snapshot identities. A new payload
      // cached during delivery can have the same millisecond timestamp.
      if (successfulPayloads.length > 0) {
        await this.cache.removeByTimestamps(
          successfulPayloads.map((payload) => payload.timestamp),
          successfulPayloads
        );
        this.logDebug(`Removed ${successfulPayloads.length} payloads from cache`);
      }
    } catch (error) {
      this.logError('Failed to replay cached payloads', error);
      retryNeeded = true;
    } finally {
      this.isReplaying = false;
      if (retryNeeded) {
        this.scheduleReplayRetry();
      } else {
        this.retryDelayMs = 1000;
      }
    }
  }

  /**
   * Send items to all other registered transports.
   * Sends cached telemetry when connectivity is restored.
   */
  private async sendToOtherTransports(items: TransportItem[]): Promise<'accepted' | 'retry' | 'blocked'> {
    const transports = this.getReplayTransports();
    if (transports.length === 0) {
      this.logWarn('No other transports registered for offline replay');
      return 'blocked';
    }

    try {
      for (const transport of transports) {
        // Recheck the live registry after each asynchronous delivery. Faro may
        // have paused or removed this target while an earlier send was pending.
        if (this.disposed || !this.getReplayTransports().includes(transport)) {
          return 'blocked';
        }
        if (transport instanceof FetchTransport) {
          // send() deliberately resolves on rejected requests and backoff. Only
          // collector acceptance is sufficient to remove the persistent copy.
          for (const group of groupItemsByMeta(items)) {
            if (this.disposed || !this.getReplayTransports().includes(transport)) {
              return 'blocked';
            }
            const result = await transport.sendWithResult(group);
            if (result.outcome !== 'accepted') {
              return result.outcome === 'rejected' && result.status !== 429 && (result.status ?? 0) < 500
                ? 'blocked'
                : 'retry';
            }
          }
        } else if (transport.isBatched()) {
          await transport.send(items);
        } else {
          for (const item of items) {
            if (this.disposed || !this.getReplayTransports().includes(transport)) {
              return 'blocked';
            }
            await transport.send(item);
          }
        }
      }
      return 'accepted';
    } catch (error) {
      this.logError('Failed to send cached payload to transports', error);
      return 'retry';
    }
  }

  private clearReplayRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleReplayRetry(): void {
    if (
      this.disposed ||
      this.retryTimer !== null ||
      !this.connectivityService.isOnline ||
      this.getReplayTransports().length === 0 ||
      (AppState.currentState && AppState.currentState !== 'active')
    ) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.forceReplay();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30000);
  }
}
