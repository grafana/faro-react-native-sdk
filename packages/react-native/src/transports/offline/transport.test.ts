import type { TransportItem } from '@grafana/faro-core';
import { mockInternalLogger } from '@grafana/faro-test-utils';

import { FetchTransport } from '../fetch';

import { AsyncStorageOfflineCache } from './OfflineCache';
import { OfflineTransport } from './transport';
import type { CachedPayload, ConnectivityService } from './types';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
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

  async write(payload: { timestamp: number; items: TransportItem[] }): Promise<void> {
    this.payloads.push({ ...payload, id: String(++this.nextId) });
  }

  async readAll(): Promise<{ timestamp: number; items: TransportItem[] }[]> {
    return [...this.payloads];
  }

  async clear(): Promise<void> {
    this.payloads = [];
  }

  async removeByTimestamps(timestamps: number[], expectedPayloads?: CachedPayload[]): Promise<void> {
    const set = new Set(timestamps);
    const ids = expectedPayloads && new Set(expectedPayloads.map((payload) => payload.id));
    this.payloads = this.payloads.filter((p) => !set.has(p.timestamp) || (ids && !ids.has(p.id)));
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

      const count = await mockCache.getCount();
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

      const count = await mockCache.getCount();
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

  describe('collector acceptance during replay', () => {
    let originalFetch: typeof global.fetch;
    let collectorFetch: jest.Mock;
    let fetchTransport: FetchTransport;

    beforeEach(() => {
      originalFetch = global.fetch;
      collectorFetch = jest.fn();
      global.fetch = collectorFetch;
      fetchTransport = new FetchTransport({ url: 'https://collector.example.com/collect' });
      fetchTransport.internalLogger = mockInternalLogger;
      fetchTransport.metas.value = { session: { id: 'live-session' } };
      transport.setOtherTransports([fetchTransport]);
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    const response = (status: number, retryAfter: string | null = null) => ({
      status,
      text: async () => '',
      headers: { get: () => retryAfter },
    });

    it.each([400, 429, 500])(
      'retains cached telemetry after HTTP %i and removes it after acceptance',
      async (status) => {
        const item = createMockTransportItem();
        await mockCache.write({ timestamp: Date.now(), items: [item] });
        collectorFetch.mockResolvedValueOnce(response(status, status === 429 ? '0' : null));

        await transport.forceReplay();

        expect(collectorFetch).toHaveBeenCalledTimes(1);
        expect(await transport.getCachedCount()).toBe(1);

        collectorFetch.mockResolvedValueOnce(response(202));
        await transport.forceReplay();

        expect(collectorFetch).toHaveBeenCalledTimes(2);
        expect(await transport.getCachedCount()).toBe(0);
      }
    );

    it('retains cached telemetry after a network failure', async () => {
      await mockCache.write({ timestamp: Date.now(), items: [createMockTransportItem()] });
      collectorFetch.mockRejectedValueOnce(new Error('offline'));

      await transport.forceReplay();

      expect(await transport.getCachedCount()).toBe(1);
      collectorFetch.mockResolvedValueOnce(response(204));
      await transport.forceReplay();
      expect(await transport.getCachedCount()).toBe(0);
    });

    it('retains cached telemetry while the fetch transport is rate limited', async () => {
      collectorFetch.mockResolvedValueOnce(response(429, '60'));
      await fetchTransport.sendWithResult([createMockTransportItem()]);
      await mockCache.write({ timestamp: Date.now(), items: [createMockTransportItem()] });

      await transport.forceReplay();

      expect(collectorFetch).toHaveBeenCalledTimes(1);
      expect(await transport.getCachedCount()).toBe(1);
    });

    it('retains the rejected payload when another payload from the same millisecond is accepted', async () => {
      const timestamp = Date.now();
      await mockCache.write({ timestamp, items: [createMockTransportItem()] });
      await mockCache.write({ timestamp, items: [createMockTransportItem()] });
      collectorFetch.mockResolvedValueOnce(response(202)).mockResolvedValueOnce(response(500));

      await transport.forceReplay();

      expect(collectorFetch).toHaveBeenCalledTimes(2);
      expect(await transport.getCachedCount()).toBe(1);
      collectorFetch.mockResolvedValue(response(202));
      await transport.forceReplay();
      expect(await transport.getCachedCount()).toBe(0);
    });

    it('stops sending cached payloads when connectivity is lost during replay', async () => {
      const timestamp = Date.now();
      await mockCache.write({ timestamp, items: [createMockTransportItem()] });
      await mockCache.write({ timestamp, items: [createMockTransportItem()] });
      collectorFetch.mockImplementationOnce(async () => {
        mockConnectivity.setOnline(false);
        return response(202);
      });

      await transport.forceReplay();

      expect(collectorFetch).toHaveBeenCalledTimes(1);
      expect(await transport.getCachedCount()).toBe(1);
    });

    it('does not let a successful secondary transport acknowledge a rejected collector request', async () => {
      const secondary = { ...fetchTransport, isBatched: () => true, send: jest.fn().mockResolvedValue(undefined) };
      transport.setOtherTransports([secondary as unknown as FetchTransport, fetchTransport]);
      await mockCache.write({ timestamp: Date.now(), items: [createMockTransportItem()] });
      collectorFetch.mockResolvedValueOnce(response(500));

      await transport.forceReplay();

      expect(secondary.send).toHaveBeenCalledTimes(1);
      expect(await transport.getCachedCount()).toBe(1);
    });
  });

  describe('getCachedCount', () => {
    it('should return correct count', async () => {
      mockConnectivity.setOnline(false);

      await transport.send([createMockTransportItem()]);
      await transport.send([createMockTransportItem()]);

      const count = await transport.getCachedCount();
      expect(count).toBe(2);
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
  let cache: AsyncStorageOfflineCache;
  const AsyncStorage = require('@react-native-async-storage/async-storage');

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new AsyncStorageOfflineCache();
  });

  describe('write and readAll', () => {
    it('should write and read payloads', async () => {
      const payload = {
        timestamp: Date.now(),
        items: [{ type: 'log' as const, payload: { message: 'test' }, meta: {} }],
      };

      AsyncStorage.getItem.mockResolvedValueOnce(null);
      AsyncStorage.setItem.mockResolvedValueOnce(undefined);

      await cache.write(payload);

      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });

    it('should respect maxCacheSize', async () => {
      const smallCache = new AsyncStorageOfflineCache({ maxCacheSize: 2 });

      // Simulate existing data with 2 items
      const existingData = [
        { timestamp: 1, items: [] },
        { timestamp: 2, items: [] },
      ];

      AsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(existingData));
      AsyncStorage.setItem.mockResolvedValueOnce(undefined);

      // Add third item
      await smallCache.write({ timestamp: 3, items: [] });

      // Should have removed oldest and kept only 2
      const setItemCall = AsyncStorage.setItem.mock.calls[0];
      const savedData = JSON.parse(setItemCall[1]);
      expect(savedData.length).toBe(2);
      expect(savedData[0].timestamp).toBe(2);
      expect(savedData[1].timestamp).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove storage key', async () => {
      await cache.clear();
      expect(AsyncStorage.removeItem).toHaveBeenCalled();
    });
  });

  describe('removeByTimestamps', () => {
    it('should remove specific payloads', async () => {
      const existingData = [
        { timestamp: 1, items: [] },
        { timestamp: 2, items: [] },
        { timestamp: 3, items: [] },
      ];

      AsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(existingData));
      AsyncStorage.setItem.mockResolvedValueOnce(undefined);

      await cache.removeByTimestamps([1, 3]);

      const setItemCall = AsyncStorage.setItem.mock.calls[0];
      const savedData = JSON.parse(setItemCall[1]);
      expect(savedData.length).toBe(1);
      expect(savedData[0].timestamp).toBe(2);
    });
  });
});
