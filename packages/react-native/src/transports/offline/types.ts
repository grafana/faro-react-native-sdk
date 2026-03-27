import type { TransportItem } from '@grafana/faro-core';

/**
 * Configuration options for the OfflineTransport.
 */
export interface OfflineTransportOptions {
  /**
   * Maximum duration to keep cached events.
   * Events older than this will be discarded on replay.
   * Default: 3 days (259200000ms)
   */
  maxCacheDurationMs?: number;

  /**
   * Maximum number of events to cache.
   * Oldest events will be discarded when limit is reached.
   * Default: 1000
   */
  maxCacheSize?: number;

  /**
   * Interval in milliseconds to check connectivity and replay cached events.
   * Default: 30000 (30 seconds)
   */
  connectivityCheckIntervalMs?: number;

  /**
   * Storage key prefix for AsyncStorage.
   * Default: 'faro_offline_cache'
   */
  storageKeyPrefix?: string;
}

/**
 * A cached telemetry payload with timestamp for expiration checking.
 */
export interface CachedPayload {
  /**
   * Timestamp when the payload was cached (milliseconds since epoch).
   */
  timestamp: number;

  /**
   * The transport items to be sent.
   */
  items: TransportItem[];
}

/**
 * Interface for connectivity detection service.
 */
export interface ConnectivityService {
  /**
   * Whether the device currently has network connectivity.
   */
  readonly isOnline: boolean;

  /**
   * Subscribe to connectivity changes.
   * @param callback Function called when connectivity state changes.
   * @returns Unsubscribe function.
   */
  subscribe(callback: (isOnline: boolean) => void): () => void;

  /**
   * Clean up resources.
   */
  dispose(): void;
}

/**
 * Interface for offline cache storage.
 */
export interface OfflineCache {
  /**
   * Write a payload to the cache.
   */
  write(payload: CachedPayload): Promise<void>;

  /**
   * Read all cached payloads.
   */
  readAll(): Promise<CachedPayload[]>;

  /**
   * Clear all cached payloads.
   */
  clear(): Promise<void>;

  /**
   * Remove specific payloads by their timestamps.
   */
  removeByTimestamps(timestamps: number[]): Promise<void>;

  /**
   * Get the number of cached payloads.
   */
  getCount(): Promise<number>;
}
