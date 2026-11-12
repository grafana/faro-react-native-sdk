import type { TransportItem } from '@grafana/faro-core';
import { mockInternalLogger } from '@grafana/faro-test-utils';

import { FetchTransport } from '../fetch';

import { AsyncStorageOfflineCache } from './OfflineCache';
import { OfflineTransport } from './transport';
import type { CachedPayload, ConnectivityService } from './types';

var mockStorage: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockStorage[key];
    return Promise.resolve();
  }),
  getAllKeys: jest.fn(() => Promise.resolve(Object.keys(mockStorage))),
  multiGet: jest.fn((keys: string[]) => Promise.resolve(keys.map((key) => [key, mockStorage[key] ?? null]))),
  multiSet: jest.fn((pairs: Array<[string, string]>) => {
    pairs.forEach(([key, value]) => {
      mockStorage[key] = value;
    });
    return Promise.resolve();
  }),
  multiRemove: jest.fn((keys: string[]) => {
    keys.forEach((key) => delete mockStorage[key]);
    return Promise.resolve();
  }),
}));

// Mock connectivity service
class MockConnectivityService implements ConnectivityService {
  private _isOnline: boolean = true;
  private subscribers: Set<(isOnline: boolean) => void> = new Set();

  get isOnline(): boolean {
    return this._isOnline;
  }

  setOnline(value: boolean): void {
    this._isOnline = value;
    this.notifySubscribers();
  }

  subscribe(callback: (isOnline: boolean) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  dispose(): void {
    this.subscribers.clear();
  }

  private notifySubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber(this._isOnline);
    }
  }
}

// Mock cache
class MockOfflineCache {
  private payloads: CachedPayload[] = [];
  private nextId = 0;

  async write(payload: CachedPayload): Promise<void> {
    this.payloads.push({ ...payload, id: payload.id ?? `p${this.nextId++}` });
  }

  async writeMany(payloads: CachedPayload[]): Promise<void> {
    for (const payload of payloads) {
      await this.write(payload);
    }
  }

  async *read(): AsyncGenerator<CachedPayload> {
    yield* [...this.payloads];
  }

  async clear(): Promise<void> {
    this.payloads = [];
  }

  async update(changes: Record<string, CachedPayload | null>): Promise<void> {
    this.payloads = this.payloads.flatMap((p) => {
      const change = p.id === undefined ? undefined : changes[p.id];
      return change === undefined ? [p] : change === null ? [] : [change];
    });
  }

  async getCount(): Promise<number> {
    return this.payloads.length;
  }
}

describe('OfflineTransport', () => {
  let transport: OfflineTransport;
  let mockConnectivity: MockConnectivityService;
  let mockCache: MockOfflineCache;

  const createMockTransportItem = (type: string = 'log'): TransportItem => ({
    type: type as TransportItem['type'],
    payload: { message: 'test' },
    meta: {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockConnectivity = new MockConnectivityService();
    mockCache = new MockOfflineCache();

    transport = new OfflineTransport({
      maxCacheDurationMs: 24 * 60 * 60 * 1000, // 1 day
    });

    // Constructor starts DefaultConnectivityService polling; dispose it before swapping in mocks
    const createdConnectivity = (transport as unknown as { connectivityService: ConnectivityService })
      .connectivityService;
    (transport as unknown as { connectivityService: ConnectivityService }).connectivityService = mockConnectivity;
    createdConnectivity.dispose();

    (transport as unknown as { cache: MockOfflineCache }).cache = mockCache;
  });

  afterEach(() => {
    transport.dispose();
    jest.useRealTimers();
  });

  describe('send', () => {
    it('should cache items when offline', async () => {
      mockConnectivity.setOnline(false);

      const item = createMockTransportItem();
      await transport.send([item]);

      const count = await transport.getCachedCount();
      expect(count).toBe(1);
    });

    it('should not cache items when online', async () => {
      mockConnectivity.setOnline(true);

      const item = createMockTransportItem();
      await transport.send([item]);

      const count = await mockCache.getCount();
      expect(count).toBe(0);
    });

    it('should handle single item', async () => {
      mockConnectivity.setOnline(false);

      const item = createMockTransportItem();
      await transport.send(item);

      const count = await transport.getCachedCount();
      expect(count).toBe(1);
    });

    it('should ignore empty items array', async () => {
      mockConnectivity.setOnline(false);

      await transport.send([]);

      const count = await mockCache.getCount();
      expect(count).toBe(0);
    });
  });

  describe('replay', () => {
    it('should replay cached items when connectivity is restored', async () => {
      // Start offline and cache some items
      mockConnectivity.setOnline(false);

      const item = createMockTransportItem();
      await transport.send([item]);

      // Set up a mock transport to receive replayed items
      const mockTransport = {
        name: 'mock-transport',
        version: '1.0.0',
        send: jest.fn().mockResolvedValue(undefined),
        getIgnoreUrls: () => [],
        isBatched: () => false,
      };

      transport.setOtherTransports([mockTransport as any]);

      // Force replay directly instead of relying on connectivity subscription
      mockConnectivity.setOnline(true);
      await transport.forceReplay();

      expect(mockTransport.send).toHaveBeenCalled();
    });

    it('replays cached items with different metadata as separate requests through FetchTransport', async () => {
      const originalFetch = global.fetch;
      const fetchMock = jest.fn((_url: string, _init: { body: string }) =>
        Promise.resolve({ status: 202, text: () => Promise.resolve(''), headers: { get: () => null } })
      );
      (global as any).fetch = fetchMock;

      try {
        mockConnectivity.setOnline(false);
        await transport.send([
          { type: 'log' as TransportItem['type'], payload: { message: 'with-user' }, meta: { user: { id: 'user-1' } } },
          { type: 'log' as TransportItem['type'], payload: { message: 'without-user' }, meta: {} },
        ]);

        const fetchTransport = new FetchTransport({ url: 'http://example.com/collect' });
        fetchTransport.metas.value = {};
        fetchTransport.internalLogger = mockInternalLogger;
        transport.setOtherTransports([fetchTransport]);

        mockConnectivity.setOnline(true);
        await transport.forceReplay();

        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
        expect(bodies).toHaveLength(2);
        expect(bodies.find((body) => body.logs[0].message === 'with-user').meta.user).toEqual({ id: 'user-1' });
        expect(bodies.find((body) => body.logs[0].message === 'without-user').meta.user).toBeUndefined();
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('should skip expired payloads', async () => {
      // Manually add an expired payload
      const expiredPayload = {
        timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        items: [createMockTransportItem()],
      };
      await mockCache.write(expiredPayload);

      const mockTransport = {
        name: 'mock-transport',
        version: '1.0.0',
        send: jest.fn().mockResolvedValue(undefined),
        getIgnoreUrls: () => [],
        isBatched: () => false,
      };

      transport.setOtherTransports([mockTransport as any]);

      // Force replay
      mockConnectivity.setOnline(true);
      await transport.forceReplay();

      // Should not send expired payload
      expect(mockTransport.send).not.toHaveBeenCalled();

      // Should have removed the expired payload
      const count = await mockCache.getCount();
      expect(count).toBe(0);
    });
  });

  describe('getCachedCount', () => {
    it('should return correct count', async () => {
      mockConnectivity.setOnline(false);

      await transport.send([createMockTransportItem()]);
      await transport.send([createMockTransportItem()]);
      // One entry per send.
      expect(await transport.getCachedCount()).toBe(2);

      await transport.send([createMockTransportItem()]);
      const count = await transport.getCachedCount();
      expect(count).toBe(3);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached items', async () => {
      mockConnectivity.setOnline(false);

      await transport.send([createMockTransportItem()]);
      await transport.send([createMockTransportItem()]);

      await transport.clearCache();

      const count = await transport.getCachedCount();
      expect(count).toBe(0);
    });
  });

  describe('isBatched', () => {
    it('should return true', () => {
      expect(transport.isBatched()).toBe(true);
    });
  });
});

describe('AsyncStorageOfflineCache', () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  const PREFIX = 'faro_offline_cache_e_';
  const LEGACY_KEY = 'faro_offline_cache_data';
  const KEY_PATTERN = /^faro_offline_cache_e_(\d{12})_(\d+)_(\d+)$/;

  const log = (message: string): TransportItem => ({
    type: 'log' as TransportItem['type'],
    payload: { message },
    meta: {},
  });

  function entryKeys(): string[] {
    return Object.keys(mockStorage)
      .filter((key) => key.startsWith(PREFIX))
      .sort();
  }

  async function readAll(cache: AsyncStorageOfflineCache): Promise<CachedPayload[]> {
    const payloads: CachedPayload[] = [];
    for await (const payload of cache.read()) {
      payloads.push(payload);
    }
    return payloads;
  }

  async function messages(cache: AsyncStorageOfflineCache): Promise<string[][]> {
    return (await readAll(cache)).map((p) => p.items.map((i) => (i.payload as { message: string }).message));
  }

  beforeEach(() => {
    mockStorage = {};
    jest.clearAllMocks();
  });

  describe('layout', () => {
    it('stores each payload under its own key, in sequence order that continues after a restart', async () => {
      const now = Date.now();
      const first = new AsyncStorageOfflineCache();
      await first.writeMany([
        { timestamp: now, items: [log('a')] },
        { timestamp: now, items: [log('b')] },
      ]);
      expect(AsyncStorage.multiSet).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      const keys = entryKeys();
      expect(keys).toHaveLength(2);
      keys.forEach((key) => {
        const match = KEY_PATTERN.exec(key);
        expect(match).not.toBeNull();
        expect(Number(match?.[2])).toBe(now);
        expect(Number(match?.[3])).toBe(mockStorage[key]?.length);
      });

      // A new instance, as after an app restart, continues the sequence.
      const second = new AsyncStorageOfflineCache();
      await second.writeMany([{ timestamp: now, items: [log('c')] }]);
      expect(entryKeys().map((key) => KEY_PATTERN.exec(key)?.[1])).toEqual([
        '000001000000',
        '000001000001',
        '000001000002',
      ]);
      expect(await messages(second)).toEqual([['a'], ['b'], ['c']]);
      expect(await second.getCount()).toBe(3);
    });

    it('gives concurrent writes distinct sequence numbers in call order', async () => {
      const cache = new AsyncStorageOfflineCache();
      await Promise.all([
        cache.writeMany([{ timestamp: 1, items: [log('a')] }]),
        cache.writeMany([
          { timestamp: 1, items: [log('b')] },
          { timestamp: 1, items: [log('c')] },
        ]),
        cache.writeMany([{ timestamp: 1, items: [log('d')] }]),
      ]);

      expect(new Set(entryKeys().map((key) => KEY_PATTERN.exec(key)?.[1])).size).toBe(4);
      expect(await messages(cache)).toEqual([['a'], ['b'], ['c'], ['d']]);
    });

    it('lists storage keys once and tracks its entries in memory afterwards', async () => {
      const cache = new AsyncStorageOfflineCache();
      for (let i = 0; i < 5; i++) {
        await cache.writeMany([{ timestamp: Date.now(), items: [log(String(i))] }]);
      }
      const [first] = await readAll(cache);
      await cache.update({ [first?.id ?? '']: null });
      await cache.getCount();

      expect(AsyncStorage.getAllKeys).toHaveBeenCalledTimes(1);
      expect(await messages(cache)).toEqual([['1'], ['2'], ['3'], ['4']]);
    });

    it('lists storage again after a write that stored part of its keys and then failed', async () => {
      const cache = new AsyncStorageOfflineCache();
      await cache.writeMany([{ timestamp: Date.now(), items: [log('a')] }]);
      AsyncStorage.multiSet.mockImplementationOnce((pairs: Array<[string, string]>) => {
        pairs.forEach(([key, value]) => {
          mockStorage[key] = value;
        });
        return Promise.reject(new Error('disk full'));
      });

      await expect(cache.writeMany([{ timestamp: Date.now(), items: [log('b')] }])).rejects.toThrow('disk full');

      expect(await cache.getCount()).toBe(2);
      expect(await messages(cache)).toEqual([['a'], ['b']]);
      await cache.writeMany([{ timestamp: Date.now(), items: [log('c')] }]);
      expect(await messages(cache)).toEqual([['a'], ['b'], ['c']]);
    });

    it('reads entries in small batches', async () => {
      const cache = new AsyncStorageOfflineCache();
      await cache.writeMany(Array.from({ length: 45 }, (_, i) => ({ timestamp: Date.now(), items: [log(String(i))] })));

      expect((await messages(cache)).flat()).toEqual(Array.from({ length: 45 }, (_, i) => String(i)));
      expect(AsyncStorage.multiGet).toHaveBeenCalledTimes(3);
      expect(Math.max(...AsyncStorage.multiGet.mock.calls.map(([keys]: [string[]]) => keys.length))).toBe(20);
    });
  });

  describe('limits', () => {
    it('evicts the oldest entries beyond maxCacheSize when writing, and reports how many', async () => {
      const warn = jest.fn();
      const cache = new AsyncStorageOfflineCache({ maxCacheSize: 2, warn });
      for (const message of ['1', '2', '3']) {
        await cache.writeMany([{ timestamp: Date.now(), items: [log(message)] }]);
      }

      expect(await messages(cache)).toEqual([['2'], ['3']]);
      expect(entryKeys()).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped 1'));
    });

    it('evicts the oldest entries beyond maxCacheBytes, and does not store an entry larger than the limit', async () => {
      const entryLength = JSON.stringify({ items: [log('x')] }).length;
      const cache = new AsyncStorageOfflineCache({ maxCacheBytes: entryLength * 2 });
      for (const message of ['1', '2', '3']) {
        await cache.writeMany([{ timestamp: Date.now(), items: [log(message)] }]);
      }
      expect(await messages(cache)).toEqual([['2'], ['3']]);

      await cache.writeMany([{ timestamp: Date.now(), items: [log('much too large '.repeat(10))] }]);
      expect(await messages(cache)).toEqual([['2'], ['3']]);
    });

    it('warns about evictions at most once a minute, with the total since the last warning', async () => {
      let now = 1_000_000;
      const warn = jest.fn();
      const cache = new AsyncStorageOfflineCache({ maxCacheSize: 1, warn, getNow: () => now });
      for (let i = 0; i < 5; i++) {
        await cache.writeMany([{ timestamp: now, items: [log(String(i))] }]);
      }
      expect(warn.mock.calls).toEqual([[expect.stringContaining('Dropped 1 ')]]);

      now += 60_000;
      await cache.writeMany([{ timestamp: now, items: [log('5')] }]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.[0]).toContain('Dropped 4 ');
    });

    it('evicts expired entries when writing', async () => {
      let now = 1_000_000;
      const cache = new AsyncStorageOfflineCache({ maxCacheDurationMs: 1_000, getNow: () => now });
      await cache.writeMany([{ timestamp: now, items: [log('old')] }]);
      now += 2_000;
      await cache.writeMany([{ timestamp: now, items: [log('new')] }]);

      expect(await messages(cache)).toEqual([['new']]);
    });
  });

  describe('unreadable data', () => {
    it('removes entries with invalid content and keys that do not parse, and leaves other keys alone', async () => {
      await new AsyncStorageOfflineCache().writeMany([{ timestamp: 5, items: [log('good')] }]);
      const item = JSON.stringify(log('x'));
      const malformed = [
        '{x}',
        '{}',
        '{"items":[null]}',
        '{"items":[{"type":"log","payload":{}}]}',
        '{"items":[{"type":"log","meta":{}}]}',
        `{"items":[${item}],"progress":{"k":-1}}`,
        `{"items":[${item}],"progress":{"k":2}}`,
        `{"items":[${item}],"progress":{"k":0.5}}`,
        `{"items":[${item}],"rejections":"x"}`,
      ];
      malformed.forEach((value, i) => {
        mockStorage[`${PREFIX}${String(2_000_000 + i).padStart(12, '0')}_5_${value.length}`] = value;
      });
      mockStorage[`${PREFIX}garbage`] = '{"items":[]}';
      mockStorage['faro_offline_cache_other'] = 'kept';
      mockStorage['unrelated'] = 'kept';
      const warn = jest.fn();
      const cache = new AsyncStorageOfflineCache({ warn });

      expect(await messages(cache)).toEqual([['good']]);
      expect(entryKeys()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Removed ${malformed.length}`));
      expect(mockStorage['faro_offline_cache_other']).toBe('kept');
      expect(mockStorage['unrelated']).toBe('kept');
    });

    it('propagates storage errors and removes nothing', async () => {
      await new AsyncStorageOfflineCache().writeMany([{ timestamp: 5, items: [log('a')] }]);
      AsyncStorage.multiRemove.mockClear();
      const cache = new AsyncStorageOfflineCache();

      AsyncStorage.getAllKeys.mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
      await expect(readAll(cache)).rejects.toThrow('storage busy');
      AsyncStorage.multiGet.mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
      await expect(readAll(cache)).rejects.toThrow('storage busy');

      expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
      expect(await messages(cache)).toEqual([['a']]);
    });
  });

  describe('update', () => {
    it('rewrites only the changed entry under the same sequence number, removes entries and ignores unknown ids', async () => {
      const cache = new AsyncStorageOfflineCache();
      await cache.writeMany([
        { timestamp: 1, items: [log('a')] },
        { timestamp: 1, items: [log('b')] },
        { timestamp: 2, items: [log('c')] },
      ]);
      const [a, b] = await readAll(cache);
      const untouched = entryKeys()[2];
      AsyncStorage.multiSet.mockClear();

      await cache.update({
        [a?.id ?? '']: null,
        [b?.id ?? '']: { ...(b as CachedPayload), progress: { x: 1 } },
        unknown: null,
      });

      expect(AsyncStorage.multiSet).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiSet.mock.calls[0][0]).toHaveLength(1);
      const keys = entryKeys();
      expect(keys).toHaveLength(2);
      expect(KEY_PATTERN.exec(keys[0] ?? '')?.[1]).toBe('000001000001');
      expect(keys[1]).toBe(untouched);
      const payloads = await readAll(cache);
      expect(payloads[0]?.progress).toEqual({ x: 1 });
      expect(payloads[0]?.timestamp).toBe(1);
    });

    it('keeps the longer key when an interrupted update left two keys for one entry', async () => {
      const short = JSON.stringify({ items: [log('a')] });
      const long = JSON.stringify({ items: [log('a')], progress: { x: 1 } });
      mockStorage[`${PREFIX}000000000001_1_${short.length}`] = short;
      mockStorage[`${PREFIX}000000000001_1_${long.length}`] = long;
      const cache = new AsyncStorageOfflineCache();

      const payloads = await readAll(cache);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.progress).toEqual({ x: 1 });
      expect(entryKeys()).toEqual([`${PREFIX}000000000001_1_${long.length}`]);
    });
  });

  describe('migration from the single-key cache of earlier versions', () => {
    it('moves entries written by main (no ids) to per-key entries, in order, and removes the old key', async () => {
      mockStorage[LEGACY_KEY] = JSON.stringify([
        { timestamp: 1, items: [log('1')] },
        { timestamp: 1, items: [log('2')] },
        { timestamp: 2, items: [log('3')] },
      ]);
      const cache = new AsyncStorageOfflineCache();

      expect(await messages(cache)).toEqual([['1'], ['2'], ['3']]);
      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
      expect(entryKeys().map((key) => KEY_PATTERN.exec(key)?.[1])).toEqual([
        '000000000001',
        '000000000002',
        '000000000003',
      ]);

      await cache.writeMany([{ timestamp: 3, items: [log('4')] }]);
      expect(await messages(cache)).toEqual([['1'], ['2'], ['3'], ['4']]);
    });

    it('keeps replay progress from entries written with ids and progress', async () => {
      mockStorage[LEGACY_KEY] = JSON.stringify([
        {
          id: '1700000000000-abcdefghij',
          timestamp: 1,
          items: [log('1'), log('2')],
          progress: { 'fetch:0a1b2c3d': 1 },
        },
        { id: '1700000000001-abcdefghij', timestamp: 2, items: [log('3')] },
      ]);
      const cache = new AsyncStorageOfflineCache();

      const payloads = await readAll(cache);
      expect(payloads.map((p) => p.progress)).toEqual([{ 'fetch:0a1b2c3d': 1 }, undefined]);
      expect(payloads.map((p) => p.id)).toEqual(['000000000001', '000000000002']);
      expect(Object.values(mockStorage).join()).not.toContain('abcdefghij');
    });

    it('keeps the newest entries that fit the limits', async () => {
      mockStorage[LEGACY_KEY] = JSON.stringify(
        ['1', '2', '3'].map((m) => ({ timestamp: Date.now(), items: [log(m)] }))
      );
      const cache = new AsyncStorageOfflineCache({ maxCacheSize: 2 });

      expect(await messages(cache)).toEqual([['2'], ['3']]);
    });

    it('is redone with the same keys when interrupted before the old key was removed', async () => {
      const legacy = JSON.stringify(['1', '2'].map((m) => ({ timestamp: 7, items: [log(m)] })));
      mockStorage[LEGACY_KEY] = legacy;
      AsyncStorage.removeItem.mockImplementationOnce(() => Promise.reject(new Error('killed')));
      await expect(new AsyncStorageOfflineCache().getCount()).resolves.toBe(0);
      const keys = entryKeys();
      expect(keys).toHaveLength(2);
      expect(mockStorage[LEGACY_KEY]).toBe(legacy);

      const cache = new AsyncStorageOfflineCache();
      expect(await messages(cache)).toEqual([['1'], ['2']]);
      expect(entryKeys()).toEqual(keys);
      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
    });

    it.each([
      ['count', { maxCacheSize: 2 }],
      ['byte', { maxCacheBytes: 2 * JSON.stringify({ items: [log('1')] }).length }],
    ])('keeps every entry at the %s limit when the old key could not be removed last time', async (_name, limits) => {
      mockStorage[LEGACY_KEY] = JSON.stringify(['1', '2'].map((m) => ({ timestamp: Date.now(), items: [log(m)] })));
      AsyncStorage.removeItem.mockImplementationOnce(() => Promise.reject(new Error('killed')));
      await new AsyncStorageOfflineCache(limits).getCount();
      expect(entryKeys()).toHaveLength(2);

      const cache = new AsyncStorageOfflineCache(limits);
      expect(await messages(cache)).toEqual([['1'], ['2']]);
      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
    });

    it('completes a migration that stored only some entries', async () => {
      mockStorage[LEGACY_KEY] = JSON.stringify(['1', '2', '3'].map((m) => ({ timestamp: 7, items: [log(m)] })));
      AsyncStorage.multiSet.mockImplementationOnce((pairs: Array<[string, string]>) => {
        const [first] = pairs;
        if (first) {
          mockStorage[first[0]] = first[1];
        }
        return Promise.reject(new Error('killed'));
      });
      await new AsyncStorageOfflineCache().getCount();
      expect(entryKeys()).toHaveLength(1);

      const cache = new AsyncStorageOfflineCache();
      expect(await messages(cache)).toEqual([['1'], ['2'], ['3']]);
      expect(entryKeys()).toHaveLength(3);
      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
    });

    it('drops malformed entries of the old cache and keeps the others', async () => {
      mockStorage[LEGACY_KEY] = JSON.stringify([
        { timestamp: 1, items: [null] },
        { timestamp: 'x', items: [log('bad timestamp')] },
        { timestamp: 2, items: [log('good')] },
      ]);

      expect(await messages(new AsyncStorageOfflineCache())).toEqual([['good']]);
    });

    it('removes an old cache that is too large to read, with a warning', async () => {
      mockStorage[LEGACY_KEY] = '[]';
      AsyncStorage.getItem.mockImplementationOnce(() =>
        Promise.reject(new Error('Row too big to fit into CursorWindow requiredPos=0, totalRows=1'))
      );
      const warn = jest.fn();
      const cache = new AsyncStorageOfflineCache({ warn });

      await cache.writeMany([{ timestamp: 1, items: [log('new')] }]);

      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('too large'));
      expect(await messages(cache)).toEqual([['new']]);
    });

    it('leaves the old cache for the next launch on other read errors, and still works', async () => {
      const legacy = JSON.stringify([{ timestamp: 1, items: [log('old')] }]);
      mockStorage[LEGACY_KEY] = legacy;
      AsyncStorage.getItem.mockImplementationOnce(() => Promise.reject(new Error('database is locked')));
      const cache = new AsyncStorageOfflineCache();

      await cache.writeMany([{ timestamp: 2, items: [log('new')] }]);
      expect(await messages(cache)).toEqual([['new']]);
      expect(mockStorage[LEGACY_KEY]).toBe(legacy);

      // Next launch: the older entries come first, so the limits evict them first.
      expect(await messages(new AsyncStorageOfflineCache())).toEqual([['old'], ['new']]);
      expect(mockStorage[LEGACY_KEY]).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all entries and the old key, and leaves other keys alone', async () => {
      const cache = new AsyncStorageOfflineCache();
      await cache.writeMany([{ timestamp: 1, items: [log('a')] }]);
      mockStorage[LEGACY_KEY] = '[]';
      mockStorage['unrelated'] = 'kept';

      await cache.clear();

      expect(Object.keys(mockStorage)).toEqual(['unrelated']);
    });
  });
});
