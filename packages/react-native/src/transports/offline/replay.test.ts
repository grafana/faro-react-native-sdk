import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  type Faro,
  initializeFaro as initializeFaroCore,
  type Transport,
  type TransportItem,
} from '@grafana/faro-core';
import { mockConfig } from '@grafana/faro-test-utils';

import { initializeFaro } from '../../initialize';
import * as sessionAttributes from '../../instrumentations/session/sessionAttributes';
import * as appBuildIdentity from '../../metas/appBuildIdentity';
import { FetchTransport } from '../fetch';

import { OfflineTransport } from './transport';
import type { CachedPayload } from './types';

var mockStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStore[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStore[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockStore[key];
    return Promise.resolve();
  }),
}));

var mockOnline = true;
var mockSubscribers = new Set<(isOnline: boolean) => void>();
jest.mock('./ConnectivityService', () => ({
  DefaultConnectivityService: class {
    get isOnline() {
      return mockOnline;
    }
    subscribe(callback: (isOnline: boolean) => void) {
      mockSubscribers.add(callback);
      callback(mockOnline);
      return () => mockSubscribers.delete(callback);
    }
    dispose() {}
  },
}));

const CACHE_KEY = 'faro_offline_cache_data';
const COLLECTOR_URL = 'http://collector.test/collect';

function setOnline(isOnline: boolean): void {
  mockOnline = isOnline;
  mockSubscribers.forEach((subscriber) => subscriber(isOnline));
}

// Real macrotask yield, unaffected by fake timers.
const realSetImmediate = jest.requireActual<typeof import('timers')>('timers').setImmediate;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

function response(status: number) {
  return Promise.resolve({ status, text: () => Promise.resolve(''), headers: { get: () => null } });
}

const fetchMock = jest.fn((_url: string, _init: { body: string }) => response(202));

type Body = { logs?: Array<{ message: string; context?: Record<string, string> }> };

function requests(): Array<{ url: string; body: Body }> {
  return fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body) as Body }));
}

function loggedMessages(url?: string): string[] {
  return requests()
    .filter((request) => url === undefined || request.url === url)
    .flatMap((request) => (request.body.logs ?? []).map((log) => log.message));
}

function cachedPayloads(): CachedPayload[] {
  const raw = mockStore[CACHE_KEY];
  return raw ? (JSON.parse(raw) as CachedPayload[]) : [];
}

function voidTransport(name: string): Transport & { send: jest.Mock } {
  return {
    name,
    version: '1.0.0',
    send: jest.fn(),
    getIgnoreUrls: () => [],
    isBatched: () => true,
  } as unknown as Transport & { send: jest.Mock };
}

const created: OfflineTransport[] = [];
function offlineTransport(): OfflineTransport {
  const transport = new OfflineTransport();
  created.push(transport);
  return transport;
}

const faros: Faro[] = [];
/**
 * Core `initializeFaro`, then the binding that this package's `initializeFaro`
 * does, unless `bind` is false (an app that uses faro-core directly).
 */
function initCore(transports: Transport[], overrides: Parameters<typeof mockConfig>[0] = {}, bind = true): Faro {
  const faro = track(
    initializeFaroCore(
      mockConfig({ transports, batching: { enabled: false }, sessionTracking: { enabled: false }, ...overrides })
    )
  );
  if (bind) {
    for (const transport of faro.transports.transports) {
      if (transport instanceof OfflineTransport) {
        transport.bindTransports(faro.transports);
      }
    }
  }
  return faro;
}

function log(message: string, meta: TransportItem['meta'] = {}): TransportItem {
  return { type: 'log', payload: { message }, meta } as TransportItem;
}

function cachedMessages(): string[][] {
  return cachedPayloads().map((p) => p.items.map((i) => (i.payload as { message: string }).message));
}

function track(faro: Faro): Faro {
  faros.push(faro);
  return faro;
}

const originalFetch = global.fetch;

beforeEach(() => {
  mockStore = {};
  mockOnline = true;
  mockSubscribers.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => response(202));
  (global as any).fetch = fetchMock;
  delete (global as any).faro;
});

afterEach(() => {
  created.splice(0).forEach((transport) => transport.dispose());
  // Stops faro-core's batch flush interval.
  faros.splice(0).forEach((faro) => faro.pause());
  jest.useRealTimers();
  (global as any).fetch = originalFetch;
});

describe('offline replay with initializeFaro from this package', () => {
  let mobileSpy: jest.SpyInstance;
  let bundleSpy: jest.SpyInstance;

  beforeEach(() => {
    mobileSpy = jest.spyOn(sessionAttributes, 'loadMobileMetaForInit').mockResolvedValue({
      sessionAttributes: sessionAttributes.minimalSessionDeviceAttributes(),
      meta: {},
    });
    bundleSpy = jest.spyOn(appBuildIdentity, 'loadAppSymbolsBundleIdForInit').mockResolvedValue(undefined);
  });

  afterEach(() => {
    mobileSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  async function init(
    config: Partial<Parameters<typeof initializeFaro>[0]>
  ): Promise<{ faro: Faro; offline: OfflineTransport }> {
    const faro = track(
      await initializeFaro({
        ...mockConfig({ sessionTracking: { enabled: true, persistent: false } }),
        url: COLLECTOR_URL,
        unpatchedConsole: { ...console, warn: jest.fn() },
        ...config,
      } as Parameters<typeof initializeFaro>[0])
    );
    const offlines = faro.transports.transports.filter((t): t is OfflineTransport => t instanceof OfflineTransport);
    created.push(...offlines);
    expect(offlines).toHaveLength(1);
    const offline = offlines[0];
    if (!offline) {
      throw new Error('no offline transport');
    }
    return { faro, offline };
  }

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'delivers cached items once, processed once (batching=%s, supplied OfflineTransport=%s)',
    async (batching, supplied) => {
      const beforeSend = jest.fn((item: TransportItem) => ({
        ...item,
        payload: {
          ...item.payload,
          context: { hooked: `${(item.payload as { context?: { hooked?: string } }).context?.hooked ?? ''}x` },
        },
      }));
      const { faro, offline } = await init({
        enableTransports: { offline: !supplied },
        transports: supplied ? [offlineTransport()] : [],
        beforeSend,
        batching: { enabled: batching, sendTimeout: 10 },
      });
      await flush();

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush();
      expect(await offline.getCachedCount()).toBe(1);
      // Cached items are not also sent live.
      expect(loggedMessages()).not.toContain('while offline');
      const offlineHookCalls = () =>
        beforeSend.mock.calls.filter(([item]) => (item.payload as { message?: string }).message === 'while offline')
          .length;
      expect(offlineHookCalls()).toBe(1);

      setOnline(true);
      await flush();

      const delivered = requests()
        .flatMap((r) => r.body.logs ?? [])
        .filter((l) => l.message === 'while offline');
      expect(delivered).toEqual([expect.objectContaining({ context: { hooked: 'x' } })]);
      // Not run again on replay.
      expect(offlineHookCalls()).toBe(1);
      expect(await offline.getCachedCount()).toBe(0);
      expect(faro.transports.transports.flatMap((t) => t.getIgnoreUrls())).toContain(COLLECTOR_URL);
    }
  );

  it('replays an earlier run’s cache at startup with enableTransports.offline', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([{ timestamp: Date.now(), items: [log('from last run')] }]);
    await init({ enableTransports: { offline: true } });
    await flush();

    expect(loggedMessages()).toContain('from last run');
    expect(cachedPayloads()).toEqual([]);
  });

  it('uses a supplied OfflineTransport and its options when enableTransports.offline is also set', async () => {
    const supplied = new OfflineTransport({ storageKeyPrefix: 'custom_prefix' });
    created.push(supplied);
    const { faro, offline } = await init({ enableTransports: { offline: true }, transports: [supplied] });
    expect(offline).toBe(supplied);

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    expect(mockStore['custom_prefix_data']).toBeDefined();
    setOnline(true);
    await flush();

    expect(loggedMessages().filter((m) => m === 'while offline')).toHaveLength(1);
    expect(await offline.getCachedCount()).toBe(0);
  });
});

describe('offline replay', () => {
  it('with faro-core initializeFaro, replays through transports set with setOtherTransports', async () => {
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    offline.setOtherTransports([fetchTransport]);
    const faro = initCore([offline, fetchTransport], {}, false);

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await offline.getCachedCount()).toBe(1);

    setOnline(true);
    await flush();

    expect(loggedMessages()).toEqual(['while offline']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('replays through a FetchTransport that is only passed to setOtherTransports', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([
      { timestamp: Date.now(), items: [log('from last run', { session: { id: 'cached-session' } })] },
    ]);
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    offline.setOtherTransports([fetchTransport]);
    const faro = initCore([offline]);
    // Its collector URL is excluded from HTTP and tracing instrumentation from the start.
    expect(faro.transports.transports.flatMap((t) => t.getIgnoreUrls())).toContain(COLLECTOR_URL);

    offline.bindTransports(faro.transports);
    await flush();

    expect(loggedMessages()).toEqual(['from last run']);
    // No metas of its own: the header uses the payload's session.
    const headers = (fetchMock.mock.calls[0]?.[1] as unknown as { headers: Record<string, string> }).headers;
    expect(headers['x-faro-session-id']).toBe('cached-session');
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('replays an earlier run’s cache once the transport is registered and online', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([
      { timestamp: Date.now(), items: [{ type: 'log', payload: { message: 'from last run' }, meta: {} }] },
    ]);
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })], {}, false);
    await flush();
    // Not bound yet: replay does not know the network transports.
    expect(fetchMock).not.toHaveBeenCalled();

    offline.bindTransports(faro.transports);
    await flush();

    expect(loggedMessages()).toEqual(['from last run']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('does not run beforeSend hooks again on replay', async () => {
    const beforeSend = jest.fn((item: TransportItem) => ({
      ...item,
      payload: {
        ...item.payload,
        context: { hooked: `${(item.payload as { context?: { hooked?: string } }).context?.hooked ?? ''}x` },
      },
    }));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })], { beforeSend } as any);

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(cachedPayloads()[0]?.items[0]?.payload).toMatchObject({ context: { hooked: 'x' } });
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    await flush();

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(requests()[0]?.body.logs?.[0]?.context).toEqual({ hooked: 'x' });
  });

  it('replays entries cached while a replay was running when connectivity returns during it', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    setOnline(false);
    faro.api.pushLog(['A']);
    await flush();

    let release: () => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(response(202) as any))) as any
    );
    setOnline(true);
    await flush();
    // A is in flight; the device drops offline, caches B, and reconnects.
    setOnline(false);
    faro.api.pushLog(['B']);
    await flush();
    expect(cachedMessages()).toEqual([['A'], ['B']]);
    setOnline(true);
    release();
    await flush();

    // No retry timer or connectivity change needed.
    expect(loggedMessages()).toEqual(['A', 'B']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('does not bring back entries evicted from the cache while a replay was running', async () => {
    const offline = new OfflineTransport({ maxCacheSize: 2 });
    created.push(offline);
    const faro = initCore([
      offline,
      new FetchTransport({ url: 'http://a.test/collect' }),
      new FetchTransport({ url: 'http://b.test/collect' }),
    ]);
    setOnline(false);
    faro.api.pushLog(['A']);
    await flush();

    // `a` accepts A after a delay, `b` fails, so the pass saves progress for A.
    let release: () => void = () => {};
    fetchMock.mockImplementation((url) =>
      url.startsWith('http://b')
        ? (Promise.reject(new Error('down')) as any)
        : (new Promise((resolve) => (release = () => resolve(response(202) as any))) as any)
    );
    setOnline(true);
    await flush();
    // While A is in flight, two new entries evict it.
    const cache = (offline as unknown as { cache: { write(p: CachedPayload): Promise<void> } }).cache;
    await cache.write({ timestamp: Date.now(), items: [log('C')] });
    await cache.write({ timestamp: Date.now(), items: [log('D')] });
    release();
    await flush();

    expect(loggedMessages('http://a.test/collect')).toEqual(['A']);
    expect(cachedMessages()).toEqual([['C'], ['D']]);
  });

  it('delivers each payload once when replays overlap', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);

    setOnline(false);
    faro.api.pushLog(['one']);
    faro.api.pushLog(['two']);
    await flush();

    let release: () => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(response(202) as any))) as any
    );

    setOnline(true);
    setOnline(false);
    setOnline(true);
    const forced = offline.forceReplay();
    await flush();
    release();
    await forced;
    await flush();

    expect(loggedMessages()).toEqual(['one', 'two']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('sends each payload once per collector URL when several FetchTransports are registered', async () => {
    const otherUrl = 'http://other-collector.test/collect';
    const offline = offlineTransport();
    const faro = initCore([
      offline,
      new FetchTransport({ url: COLLECTOR_URL }),
      new FetchTransport({ url: COLLECTOR_URL }),
      new FetchTransport({ url: otherUrl }),
    ]);

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    setOnline(true);
    await flush();

    expect(loggedMessages(COLLECTOR_URL)).toEqual(['while offline']);
    expect(loggedMessages(otherUrl)).toEqual(['while offline']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('keeps cache order across payloads and items', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);

    setOnline(false);
    for (const message of ['1', '2', '3', '4', '5']) {
      faro.api.pushLog([message]);
    }
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    setOnline(true);
    await flush();

    expect(loggedMessages()).toEqual(['1', '2', '3', '4', '5']);
  });

  it('replays a flushed batch as one request when batching is enabled', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })], {
      batching: { enabled: true, sendTimeout: 10, itemLimit: 50 },
    });

    setOnline(false);
    faro.api.pushLog(['a']);
    faro.api.pushLog(['b']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();

    expect(cachedPayloads()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    await flush();

    expect(requests()).toHaveLength(1);
    expect(loggedMessages()).toEqual(['a', 'b']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  describe('failures', () => {
    async function cacheThree(): Promise<OfflineTransport> {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);
      faro.api.pushLog(['1']);
      faro.api.pushLog(['2']);
      faro.api.pushLog(['3']);
      await flush();
      return offline;
    }

    it('keeps payloads when the request fails, stops the pass, and retries after a delay', async () => {
      const offline = await cacheThree();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

      setOnline(true);
      await flush();

      // The first payload failed; later ones were not attempted so order is kept.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(3);

      fetchMock.mockClear();
      fetchMock.mockImplementation(() => response(202));
      await jest.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await flush();

      expect(loggedMessages()).toEqual(['1', '2', '3']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('keeps payloads while FetchTransport is in backoff and does not request the collector', async () => {
      const offline = await cacheThree();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      fetchMock.mockImplementation(() => response(429));

      setOnline(true);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(3);

      // Default rate-limit backoff is 5 s; the 5 s retry may still find it active and is skipped without a request.
      fetchMock.mockClear();
      fetchMock.mockImplementation(() => response(202));
      await jest.advanceTimersByTimeAsync(5_000);
      await flush();
      await jest.advanceTimersByTimeAsync(15_000);
      await flush();

      expect(loggedMessages()).toEqual(['1', '2', '3']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('drops a payload the collector rejects with a non-retryable status and continues', async () => {
      const offline = await cacheThree();
      fetchMock.mockImplementationOnce(() => response(400));

      setOnline(true);
      await flush();

      expect(loggedMessages()).toEqual(['1', '2', '3']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('keeps a payload rejected with a server error', async () => {
      const offline = await cacheThree();
      fetchMock.mockImplementationOnce(() => response(503));

      setOnline(true);
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(3);
    });

    it('stops replaying when connectivity drops mid-replay', async () => {
      const offline = await cacheThree();
      fetchMock.mockImplementationOnce(() => {
        mockOnline = false;
        return response(202);
      });

      setOnline(true);
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(2);
    });
  });

  describe('ordering', () => {
    it('keeps capture order when metas alternate within one send', async () => {
      const offline = offlineTransport();
      initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);

      await offline.send([
        log('1', { user: { id: 'a' } }),
        log('2', { user: { id: 'b' } }),
        log('3', { user: { id: 'a' } }),
      ]);
      expect(cachedMessages()).toEqual([['1', '2', '3']]);

      setOnline(true);
      await flush();

      expect(requests()).toHaveLength(3);
      expect(loggedMessages()).toEqual(['1', '2', '3']);
    });

    it('keeps capture order across overlapping sends', async () => {
      const offline = offlineTransport();
      initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);

      const first = offline.send([log('A', { user: { id: 'a' } }), log('B', { user: { id: 'b' } })]);
      const second = offline.send([log('C', { user: { id: 'a' } })]);
      await Promise.all([first, second]);

      expect(cachedMessages()).toEqual([['A', 'B'], ['C']]);
    });
  });

  describe('real FetchTransport backoff and buffer', () => {
    it('keeps payloads without a request while the circuit breaker is open, then delivers', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);

      // Three failed live sends open the circuit breaker for 30 s.
      fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
      faro.api.pushLog(['live 1']);
      faro.api.pushLog(['live 2']);
      faro.api.pushLog(['live 3']);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => response(202));
      setOnline(true);
      await flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await offline.getCachedCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(31_000);
      await flush();
      await jest.advanceTimersByTimeAsync(31_000);
      await flush();

      expect(loggedMessages()).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('keeps payloads without a request while the request buffer is full', async () => {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL, bufferSize: 1 })]);

      let release: () => void = () => {};
      fetchMock.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(response(202) as any))) as any
      );
      faro.api.pushLog(['live']);
      await flush();

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      setOnline(true);
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(1);

      release();
      await flush();
      await offline.forceReplay();

      expect(loggedMessages()).toEqual(['live', 'while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });
  });

  describe('storage errors', () => {
    it('retries after a cache write fails during replay', async () => {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      // Removing the last payload empties the cache, which removes the storage key.
      (AsyncStorage.removeItem as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('disk full')));
      setOnline(true);
      await flush();

      // Delivered, but progress could not be saved.
      expect(loggedMessages()).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(5_000);
      await flush();

      // At least once: the retry sends it again and then removes it.
      expect(loggedMessages()).toEqual(['while offline', 'while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('keeps entries and retries when the cache cannot be read at replay start', async () => {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);
      faro.api.pushLog(['a']);
      faro.api.pushLog(['b']);
      await flush();
      expect(cachedMessages()).toEqual([['a'], ['b']]);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
      setOnline(true);
      await flush();

      // Not mistaken for an empty cache: nothing sent, nothing removed.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cachedMessages()).toEqual([['a'], ['b']]);

      await jest.advanceTimersByTimeAsync(5_000);
      await flush();

      expect(loggedMessages()).toEqual(['a', 'b']);
      expect(cachedPayloads()).toEqual([]);
    });

    it('keeps undelivered entries when the cache cannot be read while saving progress', async () => {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);
      faro.api.pushLog(['a']);
      faro.api.pushLog(['b']);
      await flush();

      // 'b' fails the first time it is sent, so it must stay cached.
      let failedB = false;
      fetchMock.mockImplementation((_url, init) => {
        const messages = ((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message);
        if (messages.includes('b') && !failedB) {
          failedB = true;
          return response(500);
        }
        return response(202);
      });

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      const getItem = AsyncStorage.getItem as jest.Mock;
      const realGetItem = getItem.getMockImplementation();
      // First read starts the replay; the second is saving progress at the end of the pass.
      getItem
        .mockImplementationOnce((key: string) => realGetItem?.(key))
        .mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
      setOnline(true);
      await flush();

      expect(loggedMessages()).toEqual(['a', 'b']);
      // Progress for 'a' was not saved, and 'b' was not lost.
      expect(cachedMessages()).toEqual([['a'], ['b']]);

      // Retry: 'a' again (at least once), then 'b'.
      await jest.advanceTimersByTimeAsync(5_000);
      await flush();

      expect(loggedMessages()).toEqual(['a', 'b', 'a', 'b']);
      expect(cachedPayloads()).toEqual([]);
    });

    it('still replays earlier payloads after a failed cache write', async () => {
      mockStore[CACHE_KEY] = JSON.stringify([{ id: 'old', timestamp: Date.now(), items: [log('earlier')] }]);
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      setOnline(false);

      (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('disk full')));
      faro.api.pushLog(['lost']);
      await flush();

      setOnline(true);
      await flush();

      expect(loggedMessages()).toEqual(['earlier']);
      expect(await offline.getCachedCount()).toBe(0);
    });
  });

  describe('custom transports', () => {
    it('does not replay to registered transports that cannot report delivery, which received items live', async () => {
      const custom = voidTransport('custom');
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL }), custom]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      expect(custom.send).toHaveBeenCalledTimes(1);

      setOnline(true);
      await flush();

      expect(custom.send).toHaveBeenCalledTimes(1);
      expect(loggedMessages()).toEqual(['while offline']);
    });

    it('skips an explicit target that is registered with Faro and is not a FetchTransport', async () => {
      const custom = voidTransport('custom');
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
      const faro = initCore([offline, fetchTransport, custom]);
      offline.setOtherTransports([custom, fetchTransport]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      setOnline(true);
      await flush();

      expect(custom.send).toHaveBeenCalledTimes(1);
      expect(loggedMessages()).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('tracks explicit targets with the same name separately', async () => {
      const first = voidTransport('custom');
      const second = voidTransport('custom');
      second.send.mockImplementationOnce(() => Promise.reject(new Error('down')));
      const offline = offlineTransport();
      const faro = initCore([offline]);
      offline.setOtherTransports([first, second]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      setOnline(true);
      await flush();
      expect(cachedPayloads()[0]?.progress).toEqual({ 'custom#0': 1 });

      await offline.forceReplay();

      expect(first.send).toHaveBeenCalledTimes(1);
      expect(second.send).toHaveBeenCalledTimes(2);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('sends one item per call to a non-batched explicit target and resumes after the last accepted item', async () => {
      const custom = voidTransport('custom');
      custom.isBatched = () => false;
      custom.send
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error('boom');
        });
      const offline = offlineTransport();
      initCore([offline]);
      offline.setOtherTransports([custom]);
      setOnline(false);
      await offline.send([log('1'), log('2'), log('3')]);

      setOnline(true);
      await flush();
      expect(cachedPayloads()[0]?.progress).toEqual({ 'custom#0': 1 });

      await offline.forceReplay();

      const sent = custom.send.mock.calls.map(([item]) => (item as TransportItem).payload);
      expect(custom.send.mock.calls.every(([item]) => !Array.isArray(item))).toBe(true);
      expect(sent).toEqual([{ message: '1' }, { message: '2' }, { message: '2' }, { message: '3' }]);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('does not cache or claim items when there is no transport to replay through', async () => {
      const custom = voidTransport('custom');
      const offline = offlineTransport();
      const faro = initCore([offline, custom]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();

      expect(custom.send).toHaveBeenCalledTimes(1);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('lets a registered FetchTransport send live when setOtherTransports() has no targets', async () => {
      const offline = offlineTransport();
      offline.setOtherTransports([]);
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();

      expect(loggedMessages()).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('replays to transports set explicitly, including ones whose send returns void, never to offline transports', async () => {
      const custom = voidTransport('custom');
      const offline = offlineTransport();
      const otherOffline = offlineTransport();
      const otherOfflineSend = jest.spyOn(otherOffline, 'send');
      const faro = initCore([offline]);
      offline.setOtherTransports([offline, otherOffline, custom]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      setOnline(true);
      await flush();

      expect(custom.send).toHaveBeenCalledTimes(1);
      expect((custom.send.mock.calls[0]?.[0] as TransportItem[])[0]?.payload).toMatchObject({
        message: 'while offline',
      });
      expect(otherOfflineSend).not.toHaveBeenCalled();
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('retries an explicit transport whose send throws', async () => {
      const custom = voidTransport('custom');
      custom.send.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const offline = offlineTransport();
      const faro = initCore([offline]);
      offline.setOtherTransports([custom]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      setOnline(true);
      await flush();
      expect(await offline.getCachedCount()).toBe(1);

      await offline.forceReplay();
      expect(custom.send).toHaveBeenCalledTimes(2);
      expect(await offline.getCachedCount()).toBe(0);
    });

    it('exposes the URLs of explicit replay transports to HTTP and tracing instrumentation', () => {
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: 'http://explicit.test/collect' });
      // Faro has not initialized it, so it has no config.
      (fetchTransport as unknown as { config: undefined }).config = undefined;
      offline.setOtherTransports([fetchTransport]);

      expect(offline.getIgnoreUrls()).toEqual(['http://explicit.test/collect']);
    });
  });

  describe('cache format', () => {
    it('replays entries without ids and with mixed metas from older versions, one request per meta', async () => {
      mockStore[CACHE_KEY] = JSON.stringify([
        {
          timestamp: Date.now(),
          items: [
            { type: 'log', payload: { message: 'user' }, meta: { user: { id: 'u1' } } },
            { type: 'log', payload: { message: 'anon' }, meta: {} },
          ],
        },
        { timestamp: Date.now(), items: [{ type: 'log', payload: { message: 'same timestamp' }, meta: {} }] },
      ]);
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
      offline.setOtherTransports([fetchTransport]);
      fetchMock.mockImplementation((_url, init) =>
        JSON.parse(init.body).logs[0].message === 'anon' ? (Promise.reject(new Error('down')) as any) : response(202)
      );

      await offline.forceReplay();

      expect(requests()).toHaveLength(2);
      expect(loggedMessages()).toEqual(['user', 'anon']);
      // The first entry remembers that its first item was delivered; the untouched entry remains.
      expect(cachedMessages()).toEqual([['user', 'anon'], ['same timestamp']]);
      expect(cachedPayloads()[0]?.progress).toEqual({ [fetchTransport.getDestinationKey()]: 1 });
      expect(cachedPayloads().every((p) => typeof p.id === 'string')).toBe(true);

      fetchMock.mockClear();
      fetchMock.mockImplementation(() => response(202));
      await offline.forceReplay();

      expect(loggedMessages()).toEqual(['anon', 'same timestamp']);
      expect(cachedPayloads()).toEqual([]);
    });

    it('does not resend a payload to a destination that already accepted it', async () => {
      const a = new FetchTransport({ url: 'http://a.test/collect' });
      const b = new FetchTransport({ url: 'http://b.test/collect' });
      const offline = offlineTransport();
      const faro = initCore([offline, a, b]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();

      fetchMock.mockImplementation((url) =>
        url.startsWith('http://b') ? (Promise.reject(new Error('down')) as any) : response(202)
      );
      setOnline(true);
      await flush();
      expect(cachedPayloads()[0]?.progress).toEqual({ [a.getDestinationKey()]: 1 });

      fetchMock.mockClear();
      fetchMock.mockImplementation(() => response(202));
      await offline.forceReplay();

      expect(loggedMessages('http://a.test/collect')).toEqual([]);
      expect(loggedMessages('http://b.test/collect')).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    });
  });

  describe('storage of progress', () => {
    it('does not store the collector URL or its token in the cache', async () => {
      const url = 'https://faro-collector.test/collect/secret-app-token';
      const a = new FetchTransport({ url });
      const b = new FetchTransport({ url: 'http://b.test/collect' });
      const offline = offlineTransport();
      const faro = initCore([offline, a, b]);

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      // Delivered to `a`, so the entry stays with progress for it.
      fetchMock.mockImplementation((requestUrl) =>
        requestUrl.startsWith('http://b') ? (Promise.reject(new Error('down')) as any) : response(202)
      );
      setOnline(true);
      await flush();

      expect(cachedPayloads()[0]?.progress).toBeDefined();
      expect(mockStore[CACHE_KEY]).not.toContain('secret-app-token');
      expect(mockStore[CACHE_KEY]).not.toContain('faro-collector.test');
    });

    it('saves replay progress in chunks instead of rewriting the cache after every entry', async () => {
      const now = Date.now();
      mockStore[CACHE_KEY] = JSON.stringify(
        Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, timestamp: now, items: [log(String(i))] }))
      );
      const setItem = AsyncStorage.setItem as jest.Mock;
      const removeItem = AsyncStorage.removeItem as jest.Mock;
      setItem.mockClear();
      removeItem.mockClear();
      const offline = offlineTransport();
      initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      await flush();
      await offline.forceReplay();

      expect(loggedMessages()).toHaveLength(120);
      expect(cachedPayloads()).toEqual([]);
      // 120 entries, saved every 50 and at the end.
      expect(setItem.mock.calls.length + removeItem.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });
});
