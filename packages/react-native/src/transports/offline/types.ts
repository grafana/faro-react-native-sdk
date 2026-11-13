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
   * Maximum total size of cached events, as serialized JSON length.
   * Oldest events are discarded when it is exceeded.
   * Default: 2 MB (2097152)
   */
  maxCacheBytes?: number;

  /**
   * @deprecated Unused: connectivity is no longer polled. Telemetry is stored
   * when sending it fails. Setting it logs a warning once.
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
   * Id of the cache entry, set by the cache when it reads the entry.
   */
  id?: string;

  /**
   * Timestamp when the payload was cached (milliseconds since epoch).
   */
  timestamp: number;

  /**
   * The transport items to be sent.
   */
  items: TransportItem[];

  /**
   * Replay progress: for each destination key, how many items from the start
   * of `items` it already received, so a retry resumes there.
   */
  progress?: Record<string, number>;

  /**
   * How many times replay got a retryable rejection (5xx or 408) for this
   * payload, or the transport threw. See `firstRejectedAt`.
   */
  rejections?: number;

  /**
   * When replay first counted a rejection (milliseconds since epoch). The
   * payload is dropped once it has enough rejections and this is old enough,
   * so a collector outage does not drop it. Entries written without it start
   * the clock at their next rejection.
   */
  firstRejectedAt?: number;
}

/**
 * Connectivity hint for the offline transport. While `isOnline` is false,
 * telemetry is stored without trying to send it.
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
   * Resolves once the first connectivity state is known: immediately without
   * NetInfo, otherwise after NetInfo's first answer.
   */
  whenKnown(): Promise<void>;

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
   * Append payloads in order, dropping the oldest entries beyond the limits.
   */
  writeMany(payloads: CachedPayload[]): Promise<void>;

  /**
   * Yields cached payloads oldest first, with their ids, reading a few at a
   * time. Rejects when storage cannot be read, so callers do not mistake it
   * for an empty cache.
   */
  read(): AsyncIterable<CachedPayload>;

  /**
   * Clear all cached payloads.
   */
  clear(): Promise<void>;

  /**
   * Updates payloads in place by id: a payload replaces the stored one, `null`
   * removes it. Unknown ids are ignored.
   */
  update(changes: Record<string, CachedPayload | null>): Promise<void>;

  /**
   * Get the number of cached payloads; 0 when storage cannot be read.
   */
  getCount(): Promise<number>;
}
