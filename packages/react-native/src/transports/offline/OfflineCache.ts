import AsyncStorage from '@react-native-async-storage/async-storage';

import type { TransportItem } from '@grafana/faro-core';

import type { CachedPayload, OfflineCache } from './types';

/**
 * Default storage key prefix for the offline cache.
 */
const DEFAULT_STORAGE_KEY_PREFIX = 'faro_offline_cache';

/**
 * Default maximum number of cached payloads.
 */
const DEFAULT_MAX_CACHE_SIZE = 1000;

/** Default maximum total serialized length of cached payloads: 2 MB. */
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024;

/** Eviction warnings are aggregated over this interval. */
const DROP_WARNING_INTERVAL_MS = 60_000;

/** Entries read per `multiGet` during replay. */
const READ_PAGE_SIZE = 20;

/** Digits of the sequence number in a key, zero-padded so that key order is storage order. */
const SEQ_DIGITS = 12;

/**
 * Sequence numbers below this are for entries migrated from the single-key
 * cache of earlier versions, so they come before every entry written by this
 * version, also when the migration runs only on a later launch.
 */
const FIRST_NEW_SEQ = 1_000_000;

interface EntryKey {
  key: string;
  seq: number;
  timestamp: number;
  length: number;
}

type StoredValue = Omit<CachedPayload, 'id' | 'timestamp'>;

export interface AsyncStorageOfflineCacheOptions {
  storageKeyPrefix?: string;
  maxCacheSize?: number;
  maxCacheBytes?: number;
  maxCacheDurationMs?: number;
  /** Receives warnings, such as how many entries were dropped. */
  warn?: (message: string) => void;
  getNow?: () => number;
}

/**
 * Persistent offline telemetry cache backed by AsyncStorage. Each payload is
 * stored under its own key, `<prefix>_e_<seq>_<timestamp>_<length>`, so no
 * value grows with the cache, and limits are enforced from the key names
 * alone. Key order is storage order.
 *
 * The keys with this prefix belong to this instance: they are listed once, on
 * first use, and tracked in memory afterwards. Operations run one at a time.
 */
export class AsyncStorageOfflineCache implements OfflineCache {
  private readonly entryPrefix: string;
  private readonly legacyKey: string;
  private readonly maxCacheSize: number;
  private readonly maxCacheBytes: number;
  private readonly maxCacheDurationMs: number;
  private readonly warn: (message: string) => void;
  private readonly getNow: () => number;
  private lockPromise: Promise<void> = Promise.resolve();
  /** Stored entries by sequence number, in sequence order; null until listed. */
  private index: Map<number, EntryKey> | null = null;
  private migrated = false;
  private droppedSinceWarning = 0;
  private lastDropWarningAt = -Infinity;
  /** Keys no longer in the index whose removal failed. */
  private readonly orphanKeys = new Set<string>();
  private nextSeq = FIRST_NEW_SEQ;

  constructor(options: AsyncStorageOfflineCacheOptions = {}) {
    const prefix = options.storageKeyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX;
    this.entryPrefix = `${prefix}_e_`;
    // Where versions before per-key storage kept the whole cache as one JSON array.
    this.legacyKey = `${prefix}_data`;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.maxCacheDurationMs = options.maxCacheDurationMs ?? Infinity;
    this.warn = options.warn ?? (() => {});
    this.getNow = options.getNow ?? (() => Date.now());
  }

  /**
   * Appends payloads in order with one `multiSet`, then removes what the
   * limits evict (oldest first) with one `multiRemove`.
   */
  async writeMany(newPayloads: CachedPayload[]): Promise<void> {
    if (newPayloads.length === 0) {
      return;
    }
    await this.withIndex(async (index) => {
      const added = newPayloads.map((payload) => this.serialize(this.nextSeq++, payload));
      const { keep, evict } = this.applyLimits([...Array.from(index.values()), ...added.map(({ entry }) => entry)]);
      const kept = new Set(keep.map(({ key }) => key));
      const toSet = added
        .filter(({ entry }) => kept.has(entry.key))
        .map(({ entry, value }): [string, string] => [entry.key, value]);
      if (toSet.length > 0) {
        await AsyncStorage.multiSet(toSet);
      }
      added.forEach(({ entry }) => kept.has(entry.key) && index.set(entry.seq, entry));
      const stored = evict.filter(({ seq }) => index.get(seq) !== undefined);
      if (stored.length > 0) {
        await this.removeKeys(stored.map(({ key }) => key));
        stored.forEach(({ seq }) => index.delete(seq));
      }
      this.reportDropped(evict.length);
    });
  }

  /**
   * Yields payloads oldest first, reading a few at a time. Entries written
   * after it started are not included; entries removed meanwhile are skipped,
   * and malformed ones are removed. Rejects when storage cannot be read.
   */
  async *read(): AsyncGenerator<CachedPayload> {
    const entries = await this.withIndex(async (index) => Array.from(index.values()));
    for (let i = 0; i < entries.length; i += READ_PAGE_SIZE) {
      const page = entries.slice(i, i + READ_PAGE_SIZE);
      const payloads = await this.withIndex(async (index) => {
        const current = page.filter((entry) => index.get(entry.seq)?.key === entry.key);
        if (current.length === 0) {
          return [];
        }
        const values = await AsyncStorage.multiGet(current.map(({ key }) => key));
        const result: CachedPayload[] = [];
        const malformed: EntryKey[] = [];
        values.forEach(([key, value], position) => {
          const entry = current[position];
          if (!entry || entry.key !== key) {
            return;
          }
          if (value == null) {
            // Removed outside this cache.
            index.delete(entry.seq);
            return;
          }
          const parsed = parseValue(value);
          if (parsed) {
            result.push({ ...parsed, timestamp: entry.timestamp, id: formatSeq(entry.seq) });
          } else {
            malformed.push(entry);
          }
        });
        if (malformed.length > 0) {
          await this.removeKeys(malformed.map(({ key }) => key));
          malformed.forEach(({ seq }) => index.delete(seq));
          this.warn(`Removed ${malformed.length} unreadable offline cache entries`);
        }
        return result;
      });
      for (const payload of payloads) {
        yield payload;
      }
    }
  }

  /**
   * Updates payloads by id: a payload replaces the stored one under the same
   * sequence number, `null` removes it. Ids that are no longer stored are
   * ignored, so evicted entries do not come back.
   */
  async update(changes: Record<string, CachedPayload | null>): Promise<void> {
    await this.withIndex(async (index) => {
      const toSet: Array<[string, string]> = [];
      const replaced: EntryKey[] = [];
      const removed: EntryKey[] = [];
      for (const [id, change] of Object.entries(changes)) {
        const entry = /^\d+$/.test(id) ? index.get(Number(id)) : undefined;
        if (!entry) {
          continue;
        }
        if (change === null) {
          removed.push(entry);
          continue;
        }
        const { entry: next, value } = this.serialize(entry.seq, { ...change, timestamp: entry.timestamp });
        toSet.push([next.key, value]);
        replaced.push(next);
        if (next.key !== entry.key) {
          removed.push(entry);
        }
      }
      // Written before the old key is removed: an interrupted update leaves both, and the longer one wins.
      if (toSet.length > 0) {
        await AsyncStorage.multiSet(toSet);
        replaced.forEach((entry) => index.set(entry.seq, entry));
      }
      const replacedSeqs = new Set(replaced.map(({ seq }) => seq));
      if (removed.length > 0) {
        // Old keys of rewritten entries are no longer indexed: if removing them fails, retry with the next removal.
        await this.removeKeys(
          removed.map(({ key }) => key),
          removed.filter(({ seq }) => replacedSeqs.has(seq)).map(({ key }) => key)
        );
        removed.forEach(({ seq }) => !replacedSeqs.has(seq) && index.delete(seq));
      }
    });
  }

  async clear(): Promise<void> {
    await this.withIndex(async (index) => {
      await this.removeKeys([...Array.from(index.values(), ({ key }) => key), this.legacyKey]);
      index.clear();
    });
  }

  /**
   * Returns 0 when storage cannot be read.
   */
  async getCount(): Promise<number> {
    try {
      return await this.withIndex(async (index) => index.size);
    } catch {
      return 0;
    }
  }

  /**
   * Removes keys with one `multiRemove`, together with unindexed keys an
   * earlier removal failed for. On failure, `unindexed` is kept for the next.
   */
  private async removeKeys(keys: string[], unindexed: string[] = []): Promise<void> {
    const all = Array.from(new Set(Array.from(this.orphanKeys).concat(keys)));
    try {
      await AsyncStorage.multiRemove(all);
      this.orphanKeys.clear();
    } catch (error) {
      unindexed.forEach((key) => this.orphanKeys.add(key));
      throw error;
    }
  }

  /** Runs `operation` alone, with the entry index loaded and the old cache migrated. */
  private async withIndex<T>(operation: (index: Map<number, EntryKey>) => Promise<T>): Promise<T> {
    const currentLock = this.lockPromise;
    let resolveLock: () => void = () => {};
    this.lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    try {
      await currentLock;
      const index = this.index ?? (await this.loadIndex());
      this.index = index;
      if (!this.migrated) {
        await this.migrate(index);
      }
      return await operation(index);
    } catch (error) {
      // A failed write may have stored part of its keys; list storage again on the next operation.
      this.index = null;
      throw error;
    } finally {
      resolveLock();
    }
  }

  /**
   * Lists the stored entries once and removes keys with this prefix that do
   * not parse. Storage errors propagate, so callers never mistake unavailable
   * storage for an empty cache; the next operation lists again.
   */
  private async loadIndex(): Promise<Map<number, EntryKey>> {
    const keys = await AsyncStorage.getAllKeys();
    const bySeq = new Map<number, EntryKey>();
    const remove: string[] = [];
    for (const key of keys) {
      if (!key.startsWith(this.entryPrefix)) {
        continue;
      }
      const entry = parseKey(key.slice(this.entryPrefix.length), key);
      if (!entry) {
        remove.push(key);
        continue;
      }
      // Two keys for one entry: an update was interrupted. Progress only grows, so the longer one is newer.
      const other = bySeq.get(entry.seq);
      if (other) {
        const [newer, older] = entry.length > other.length ? [entry, other] : [other, entry];
        remove.push(older.key);
        bySeq.set(entry.seq, newer);
      } else {
        bySeq.set(entry.seq, entry);
      }
    }
    if (remove.length > 0) {
      await AsyncStorage.multiRemove(remove);
    }
    const index = sortedIndex(bySeq.values());
    const last = Array.from(index.keys()).pop();
    if (last !== undefined && last >= this.nextSeq) {
      this.nextSeq = last + 1;
    }
    return index;
  }

  /** Splits entries, oldest first, into the ones within the age, count and byte limits and the rest. */
  private applyLimits(entries: EntryKey[]): { keep: EntryKey[]; evict: EntryKey[] } {
    const oldest = this.getNow() - this.maxCacheDurationMs;
    // An entry larger than the byte limit on its own never fits; it must not push out the others.
    const fits = ({ timestamp, length }: EntryKey) => timestamp >= oldest && length <= this.maxCacheBytes;
    const fresh = entries.filter(fits);
    const evict = entries.filter((entry) => !fits(entry));
    let bytes = fresh.reduce((sum, { length }) => sum + length, 0);
    let start = 0;
    while (start < fresh.length && (fresh.length - start > this.maxCacheSize || bytes > this.maxCacheBytes)) {
      const entry = fresh[start++];
      if (entry) {
        bytes -= entry.length;
        evict.push(entry);
      }
    }
    return { keep: fresh.slice(start), evict };
  }

  private serialize(seq: number, payload: CachedPayload): { entry: EntryKey; value: string } {
    const { id: _id, timestamp: rawTimestamp, ...rest } = payload;
    const timestamp = Math.max(0, Math.floor(rawTimestamp));
    const value = JSON.stringify(rest);
    const key = `${this.entryPrefix}${formatSeq(seq)}_${timestamp}_${value.length}`;
    return { entry: { key, seq, timestamp, length: value.length }, value };
  }

  /** Warns at most once a minute, with the total dropped since the last warning. */
  private reportDropped(count: number): void {
    this.droppedSinceWarning += count;
    const now = this.getNow();
    if (this.droppedSinceWarning > 0 && now - this.lastDropWarningAt >= DROP_WARNING_INTERVAL_MS) {
      this.warn(`Dropped ${this.droppedSinceWarning} offline cache entries to stay within the cache limits`);
      this.droppedSinceWarning = 0;
      this.lastDropWarningAt = now;
    }
  }

  /**
   * Moves the single-key cache of earlier versions to per-key entries, once
   * per instance, before the first operation. Its entries get the sequence
   * numbers 1..n, before every entry this version writes. The keys are
   * deterministic, so a migration interrupted before the old key is removed
   * is redone with the same keys, which count once.
   */
  private async migrate(index: Map<number, EntryKey>): Promise<void> {
    let raw: string | null;
    try {
      raw = await AsyncStorage.getItem(this.legacyKey);
    } catch (error) {
      this.migrated = true;
      const message = String((error as { message?: unknown } | null)?.message ?? error);
      if (/row too big|cursorwindow/i.test(message)) {
        // Too large to read back (Android cursor window): it can never be migrated.
        await AsyncStorage.removeItem(this.legacyKey);
        this.warn('Removed an offline cache from an earlier version that is too large to read');
      }
      // Otherwise possibly temporary: left for the next launch.
      return;
    }
    this.migrated = true;
    if (raw == null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const legacy = (Array.isArray(parsed) ? (parsed as unknown[]) : []).flatMap((payload): CachedPayload[] => {
      if (!isRecord(payload) || typeof payload['timestamp'] !== 'number') {
        return [];
      }
      const value = parseStored(payload);
      return value ? [{ ...value, timestamp: payload['timestamp'] }] : [];
    });

    let migrated = legacy.map((payload, position) => this.serialize(position + 1, payload));
    // The low range is taken by other entries (not by an interrupted run of this migration), as after
    // downgrading and upgrading again: use the numbers after them, still before this version's entries.
    if (migrated.some(({ entry }) => index.has(entry.seq) && index.get(entry.seq)?.key !== entry.key)) {
      const base = Math.max(0, ...Array.from(index.keys()).filter((seq) => seq < FIRST_NEW_SEQ));
      migrated = legacy.map((payload, position) => this.serialize(base + position + 1, payload));
    }
    // An entry already stored under the same key is the same entry, from an interrupted migration.
    const fresh = migrated.filter(({ entry }) => index.get(entry.seq)?.key !== entry.key);
    const all = sortedIndex([...Array.from(index.values()), ...fresh.map(({ entry }) => entry)]);
    const { keep, evict } = this.applyLimits(Array.from(all.values()));
    const kept = new Set(keep.map(({ key }) => key));
    const toSet = fresh
      .filter(({ entry }) => kept.has(entry.key))
      .map(({ entry, value }): [string, string] => [entry.key, value]);
    const storedEvicted = evict.filter(({ seq, key }) => index.get(seq)?.key === key);
    if (toSet.length > 0) {
      await AsyncStorage.multiSet(toSet);
    }
    // The index stays in sequence order.
    replaceIndex(index, [...keep, ...storedEvicted]);
    if (storedEvicted.length > 0) {
      await this.removeKeys(storedEvicted.map(({ key }) => key));
      replaceIndex(index, keep);
    }
    await AsyncStorage.removeItem(this.legacyKey);
    this.reportDropped(evict.length);
  }
}

function formatSeq(seq: number): string {
  return String(seq).padStart(SEQ_DIGITS, '0');
}

function replaceIndex(index: Map<number, EntryKey>, entries: EntryKey[]): void {
  const sorted = sortedIndex(entries);
  index.clear();
  sorted.forEach((entry, seq) => index.set(seq, entry));
}

function sortedIndex(entries: Iterable<EntryKey>): Map<number, EntryKey> {
  return new Map(Array.from(entries, (entry): [number, EntryKey] => [entry.seq, entry]).sort(([a], [b]) => a - b));
}

const KEY_PATTERN = /^(\d{12})_(\d+)_(\d+)$/;

function parseKey(suffix: string, key: string): EntryKey | null {
  const match = KEY_PATTERN.exec(suffix);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }
  return { key, seq: Number(match[1]), timestamp: Number(match[2]), length: Number(match[3]) };
}

function parseValue(value: string): StoredValue | null {
  try {
    return parseStored(JSON.parse(value));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts only what replay can send: items shaped like transport items
 * (`type`, `payload` and `meta`, as the request body is built from them) and
 * progress cursors that are counts of items.
 */
function parseStored(value: unknown): StoredValue | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) {
    return null;
  }
  const items = value['items'] as unknown[];
  const validItem = (item: unknown) =>
    isRecord(item) && typeof item['type'] === 'string' && isRecord(item['payload']) && isRecord(item['meta']);
  if (!items.every(validItem)) {
    return null;
  }
  const isCount = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
  const progress = value['progress'];
  if (
    progress !== undefined &&
    (!isRecord(progress) || !Object.values(progress).every((n) => isCount(n, items.length)))
  ) {
    return null;
  }
  const rejections = value['rejections'];
  if (rejections !== undefined && !isCount(rejections, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const firstRejectedAt = value['firstRejectedAt'];
  if (firstRejectedAt !== undefined && !isCount(firstRejectedAt, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return {
    items: items as TransportItem[],
    ...(progress !== undefined && { progress: progress as Record<string, number> }),
    ...(rejections !== undefined && { rejections: rejections as number }),
    ...(firstRejectedAt !== undefined && { firstRejectedAt: firstRejectedAt as number }),
  };
}
