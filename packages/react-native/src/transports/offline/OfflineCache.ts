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
      payloads.push({ ...payload, id: genShortID() });

      // Trim to max size (remove oldest entries)
      while (payloads.length > this.maxCacheSize) {
        payloads.shift();
      }

      await this.writeAll(payloads);
    });
  }

  async readAll(): Promise<CachedPayload[]> {
    return this.withLock(async () => {
      const payloads = await this.readAllInternal();
      let migrated = false;
      const ids = new Set<string>();
      for (const payload of payloads) {
        if (typeof payload.id !== 'string' || !payload.id || ids.has(payload.id)) {
          payload.id = genShortID();
          migrated = true;
        }
        ids.add(payload.id);
      }
      if (migrated) {
        await this.writeAll(payloads);
      }
      return payloads;
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await AsyncStorage.removeItem(this.storageKey);
    });
  }

  async removeByTimestamps(timestamps: number[], expectedPayloads?: CachedPayload[]): Promise<void> {
    if (timestamps.length === 0) return;

    const timestampSet = new Set(timestamps);
    const expectedIds =
      expectedPayloads && new Set(expectedPayloads.flatMap((payload) => (payload.id ? [payload.id] : [])));

    await this.withLock(async () => {
      const payloads = await this.readAllInternal();
      const remaining = payloads.filter((payload) => {
        const expected = expectedIds === undefined || (payload.id !== undefined && expectedIds.has(payload.id));
        return !timestampSet.has(payload.timestamp) || !expected;
      });
      await this.writeAll(remaining);
    });
  }

  async getCount(): Promise<number> {
    const payloads = await this.readAllInternal();
    return payloads.length;
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

  private async readAllInternal(): Promise<CachedPayload[]> {
    try {
      const data = await AsyncStorage.getItem(this.storageKey);
      if (!data) {
        return [];
      }

      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(this.isValidCachedPayload);
    } catch {
      // If parsing fails, return empty array
      return [];
    }
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
