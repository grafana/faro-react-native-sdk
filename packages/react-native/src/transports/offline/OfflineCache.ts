import AsyncStorage from '@react-native-async-storage/async-storage';

import { genShortID } from '@grafana/faro-core';

import type { CachedPayload, OfflineCache } from './types';

/**
 * Default storage key prefix for the offline cache.
 */
const DEFAULT_STORAGE_KEY_PREFIX = 'faro_offline_cache';

/**
 * Default maximum number of cached payloads.
 */
const DEFAULT_MAX_CACHE_SIZE = 1000;

/**
 * File-based offline cache implementation using AsyncStorage.
 *
 * Stores cached telemetry payloads as JSONL (one JSON object per line)
 * Persistent offline telemetry cache backed by AsyncStorage.
 *
 * Uses a mutex pattern for thread-safe file access.
 */
export class AsyncStorageOfflineCache implements OfflineCache {
  private readonly storageKey: string;
  private readonly maxCacheSize: number;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(options: { storageKeyPrefix?: string; maxCacheSize?: number } = {}) {
    this.storageKey = `${options.storageKeyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX}_data`;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  async write(payload: CachedPayload): Promise<void> {
    await this.withLock(async () => {
      const payloads = await this.readAllInternal();

      // Add new payload
      payloads.push(payload.id ? payload : { ...payload, id: createPayloadId() });

      // Trim to max size (remove oldest entries)
      while (payloads.length > this.maxCacheSize) {
        payloads.shift();
      }

      await this.writeAll(payloads);
    });
  }

  /**
   * Reads all payloads, oldest first. Entries written by older SDK versions get
   * an id, which is persisted so later `replace()` calls can find them.
   */
  async readAll(): Promise<CachedPayload[]> {
    return this.withLock(async () => {
      const payloads = await this.readAllInternal();
      if (payloads.some((payload) => !payload.id)) {
        const withIds = payloads.map((payload) => (payload.id ? payload : { ...payload, id: createPayloadId() }));
        await this.writeAll(withIds);
        return withIds;
      }
      return payloads;
    });
  }

  async replace(replacements: Record<string, CachedPayload[]>): Promise<void> {
    await this.withLock(async () => {
      const payloads = await this.readAllInternal();
      const updated = payloads.flatMap((payload) => {
        if (!payload.id || !Object.prototype.hasOwnProperty.call(replacements, payload.id)) {
          return [payload];
        }
        return (replacements[payload.id] ?? []).map((replacement) =>
          replacement.id ? replacement : { ...replacement, id: createPayloadId() }
        );
      });
      await this.writeAll(updated);
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await AsyncStorage.removeItem(this.storageKey);
    });
  }

  async removeByTimestamps(timestamps: number[]): Promise<void> {
    if (timestamps.length === 0) return;

    const timestampSet = new Set(timestamps);

    await this.withLock(async () => {
      const payloads = await this.readAllInternal();
      const remaining = payloads.filter((p) => !timestampSet.has(p.timestamp));
      await this.writeAll(remaining);
    });
  }

  /**
   * Returns 0 when storage cannot be read.
   */
  async getCount(): Promise<number> {
    try {
      const payloads = await this.readAllInternal();
      return payloads.length;
    } catch {
      return 0;
    }
  }

  /**
   * Execute an operation with a mutex lock to ensure thread-safe access.
   * Async lock to serialize cache read/write operations.
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const currentLock = this.lockPromise;
    let resolveLock: () => void;
    this.lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    try {
      await currentLock;
      return await operation();
    } finally {
      resolveLock!();
    }
  }

  /**
   * Storage read errors propagate, so callers never mistake unavailable storage
   * for an empty cache and overwrite entries that were not delivered. Only
   * unreadable data (invalid JSON or shape) counts as empty.
   */
  private async readAllInternal(): Promise<CachedPayload[]> {
    const data = await AsyncStorage.getItem(this.storageKey);
    if (!data) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }

    return Array.isArray(parsed) ? parsed.filter(this.isValidCachedPayload) : [];
  }

  private async writeAll(payloads: CachedPayload[]): Promise<void> {
    if (payloads.length === 0) {
      await AsyncStorage.removeItem(this.storageKey);
    } else {
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(payloads));
    }
  }

  private isValidCachedPayload(payload: unknown): payload is CachedPayload {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }

    const p = payload as Record<string, unknown>;
    return typeof p['timestamp'] === 'number' && Array.isArray(p['items']);
  }
}

function createPayloadId(): string {
  return `${Date.now()}-${genShortID(10)}`;
}
