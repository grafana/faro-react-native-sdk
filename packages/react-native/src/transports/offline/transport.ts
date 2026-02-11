import { BaseTransport, VERSION } from '@grafana/faro-core';
import type { Patterns, Transport, TransportItem } from '@grafana/faro-core';

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
 * Implementation follows Flutter SDK's OfflineTransport pattern:
 * - Uses AsyncStorage for persistent caching (matching Flutter's SharedPreferences)
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
  private readonly otherTransports: Transport[] = [];
  private unsubscribeConnectivity: (() => void) | null = null;
  private isReplaying: boolean = false;

  constructor(options: OfflineTransportOptions = {}) {
    super();

    this.maxCacheDurationMs = options.maxCacheDurationMs ?? DEFAULT_MAX_CACHE_DURATION_MS;

    this.cache = new AsyncStorageOfflineCache({
      storageKeyPrefix: options.storageKeyPrefix,
      maxCacheSize: options.maxCacheSize,
    });

    this.connectivityService = new DefaultConnectivityService(options.connectivityCheckIntervalMs);

    // Subscribe to connectivity changes
    this.unsubscribeConnectivity = this.connectivityService.subscribe((isOnline) => {
      if (isOnline && !this.isReplaying) {
        this.replayCachedPayloads();
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
   * Called by the transport system after initialization.
   */
  setOtherTransports(transports: Transport[]): void {
    this.otherTransports.length = 0;
    for (const transport of transports) {
      if (transport !== this) {
        this.otherTransports.push(transport);
      }
    }
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
    if (this.connectivityService.isOnline) {
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
    if (this.unsubscribeConnectivity) {
      this.unsubscribeConnectivity();
      this.unsubscribeConnectivity = null;
    }
    this.connectivityService.dispose();
  }

  /**
   * Replay cached payloads through other transports.
   * Follows Flutter SDK's _readFromFile pattern.
   */
  private async replayCachedPayloads(): Promise<void> {
    if (this.isReplaying) {
      return;
    }

    this.isReplaying = true;

    try {
      const payloads = await this.cache.readAll();

      if (payloads.length === 0) {
        return;
      }

      this.logDebug(`Replaying ${payloads.length} cached payloads`);

      const now = Date.now();
      const successfulTimestamps: number[] = [];

      for (const payload of payloads) {
        // Skip expired payloads
        if (now - payload.timestamp > this.maxCacheDurationMs) {
          this.logDebug(`Skipping expired payload from ${new Date(payload.timestamp).toISOString()}`);
          successfulTimestamps.push(payload.timestamp);
          continue;
        }

        const success = await this.sendToOtherTransports(payload.items);

        if (success) {
          successfulTimestamps.push(payload.timestamp);
        }
      }

      // Remove successfully sent or expired payloads
      if (successfulTimestamps.length > 0) {
        await this.cache.removeByTimestamps(successfulTimestamps);
        this.logDebug(`Removed ${successfulTimestamps.length} payloads from cache`);
      }
    } catch (error) {
      this.logError('Failed to replay cached payloads', error);
    } finally {
      this.isReplaying = false;
    }
  }

  /**
   * Send items to all other registered transports.
   * Follows Flutter SDK's _sendCachedData pattern.
   */
  private async sendToOtherTransports(items: TransportItem[]): Promise<boolean> {
    if (this.otherTransports.length === 0) {
      this.logWarn('No other transports registered for offline replay');
      return false;
    }

    try {
      for (const transport of this.otherTransports) {
        await transport.send(items);
      }
      return true;
    } catch (error) {
      this.logError('Failed to send cached payload to transports', error);
      return false;
    }
  }
}
