import type { Transport, TransportItem } from '@grafana/faro-core';

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
   * Unique id of the cache entry. Entries written by older SDK versions have
   * none; the cache assigns one when it reads them.
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
   * Destination keys (see `DeliveryReportingTransport.getDestinationKey`) that
   * already received this payload during replay, so a retry does not send it
   * to them again.
   */
  deliveredTo?: string[];

  /**
   * For destinations that take one item per send (`isBatched()` is false), the
   * number of items they already accepted, so a retry resumes after them.
   */
  itemCursors?: Record<string, number>;
}

/**
 * Internal to the offline replay; not exported from the package.
 *
 * Outcome of one send attempt reported by a transport.
 *
 * - `accepted`: the destination accepted the items.
 * - `rejected`: the destination answered with a non-success status.
 * - `failed`: the request did not complete (network error, timeout, full request buffer).
 * - `skipped`: the transport did not try, for example during a rate-limit or failure backoff.
 */
export type DeliveryOutcome = 'accepted' | 'rejected' | 'failed' | 'skipped';

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  status?: number;
}

/**
 * A transport that reports whether a send reached its destination.
 * `FetchTransport` implements it. Replay uses it for transports set with
 * `OfflineTransport.setOtherTransports()` when they provide it. Internal; not
 * exported from the package.
 */
export interface DeliveryReportingTransport extends Transport {
  /**
   * Sends items that share one meta block as one request and reports the outcome.
   */
  sendWithResult(items: TransportItem[]): Promise<DeliveryResult>;

  /**
   * Identifies the destination. Transports that return the same key are one
   * destination, so replay sends each cached payload to it once. The key is
   * stored with cached payloads, so it must not contain credentials.
   */
  getDestinationKey?(): string;
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
   * Read all cached payloads. Rejects when storage cannot be read, so callers
   * do not mistake it for an empty cache.
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
   * Replace payloads in place. Each key is a payload id and its value the
   * payloads that take its place, in order; an empty list removes it. Unknown
   * ids are ignored.
   */
  replace(replacements: Record<string, CachedPayload[]>): Promise<void>;

  /**
   * Get the number of cached payloads; 0 when storage cannot be read.
   */
  getCount(): Promise<number>;
}
