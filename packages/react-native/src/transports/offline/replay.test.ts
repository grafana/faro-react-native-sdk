import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import {
  BaseInstrumentation,
  defaultUnpatchedConsole,
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
  getAllKeys: jest.fn(() => Promise.resolve(Object.keys(mockStore))),
  multiGet: jest.fn((keys: string[]) => Promise.resolve(keys.map((key) => [key, mockStore[key] ?? null]))),
  multiSet: jest.fn((pairs: Array<[string, string]>) => {
    pairs.forEach(([key, value]) => {
      mockStore[key] = value;
    });
    return Promise.resolve();
  }),
  multiRemove: jest.fn((keys: string[]) => {
    keys.forEach((key) => delete mockStore[key]);
    return Promise.resolve();
  }),
}));

var mockOnline = true;
var mockSubscribers = new Set<(isOnline: boolean) => void>();
var mockKnown: Promise<void> = Promise.resolve();
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
    whenKnown() {
      return mockKnown;
    }
    dispose() {}
  },
}));

/** Where versions before per-key storage kept the whole cache. */
const CACHE_KEY = 'faro_offline_cache_data';
const ENTRY_PREFIX = 'faro_offline_cache_e_';
const COLLECTOR_URL = 'http://collector.test/collect';

function setOnline(isOnline: boolean): void {
  mockOnline = isOnline;
  mockSubscribers.forEach((subscriber) => subscriber(isOnline));
}

type Flushable = { waitForWrites(): Promise<void> };

// Real macrotask yield, unaffected by fake timers.
const realSetImmediate = jest.requireActual<typeof import('timers')>('timers').setImmediate;

/** Settles promises and waits for the offline transports' cache writes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.all(created.map((transport) => (transport as unknown as Partial<Flushable>).waitForWrites?.()));
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

function entryKeys(prefix = ENTRY_PREFIX): string[] {
  return Object.keys(mockStore)
    .filter((key) => key.startsWith(prefix))
    .sort();
}

function cachedPayloads(prefix = ENTRY_PREFIX): CachedPayload[] {
  return entryKeys(prefix).map((key) => {
    const [seq, timestamp] = key.slice(prefix.length).split('_');
    return {
      id: seq,
      timestamp: Number(timestamp),
      ...(JSON.parse(mockStore[key] ?? '{}') as object),
    } as CachedPayload;
  });
}

/** Stores entries in the current per-key format, oldest first. */
function seedEntries(payloads: Array<Omit<CachedPayload, 'id'>>): void {
  payloads.forEach(({ timestamp, ...rest }, index) => {
    const value = JSON.stringify(rest);
    mockStore[`${ENTRY_PREFIX}${String(index + 1).padStart(12, '0')}_${timestamp}_${value.length}`] = value;
  });
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
  mockKnown = Promise.resolve();
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

  class LogsAtInit extends BaseInstrumentation {
    readonly name = 'test:logs-at-init';
    readonly version = '1.0.0';
    initialize(): void {
      this.api.pushLog(['during init']);
    }
  }

  it('stores what is sent while Faro initializes offline once, and delivers it once after reconnecting', async () => {
    mockOnline = false;
    const { offline } = await init({ enableTransports: { offline: true }, instrumentations: [new LogsAtInit()] });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      cachedMessages()
        .flat()
        .filter((m) => m === 'during init')
    ).toHaveLength(1);

    setOnline(true);
    await flush();

    expect(loggedMessages().filter((m) => m === 'during init')).toHaveLength(1);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('stores what is sent while Faro initializes for each collector, including one supplied in transports, and delivers it once to each', async () => {
    const otherUrl = 'http://supplied.test/collect';
    let status = 503;
    fetchMock.mockImplementation(() => response(status));
    const { offline } = await init({
      enableTransports: { offline: true },
      transports: [new FetchTransport({ url: otherUrl })],
      // HttpInstrumentation does not skip a supplied transport's URL by itself.
      ignoreUrls: [otherUrl],
      instrumentations: [new LogsAtInit()],
    });
    await flush();
    fetchMock.mockClear();

    status = 202;
    await offline.forceReplay();
    await offline.forceReplay();

    expect(loggedMessages(COLLECTOR_URL).filter((m) => m === 'during init')).toHaveLength(1);
    expect(loggedMessages(otherUrl).filter((m) => m === 'during init')).toHaveLength(1);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('stores and later delivers once what is sent while Faro initializes and the collector answers 503', async () => {
    let status = 503;
    const accepted: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      if (status === 202) {
        accepted.push(...((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message));
      }
      return response(status);
    });
    const { offline } = await init({ enableTransports: { offline: true }, instrumentations: [new LogsAtInit()] });
    await flush();
    expect(loggedMessages()).toContain('during init');
    expect(cachedMessages().flat()).toContain('during init');

    status = 202;
    await offline.forceReplay();
    await offline.forceReplay();

    expect(accepted).toEqual(['during init']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('stores telemetry captured offline for a FetchTransport that is only passed to setOtherTransports', async () => {
    const otherUrl = 'http://replay-only.test/collect';
    const supplied = offlineTransport();
    supplied.setOtherTransports([new FetchTransport({ url: otherUrl })]);
    const { faro, offline } = await init({ transports: [supplied] });
    await flush();

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    // Other entries hold session events, which are not logs.
    expect(cachedMessages().flat()).toContain('while offline');

    setOnline(true);
    await flush();

    expect(loggedMessages(otherUrl)).toEqual(['while offline']);
    expect(await offline.getCachedCount()).toBe(0);
  });

  // faro-core registers a non-isolated instance on the global object for good, so this is one test.
  it('resolves when Faro is already initialized, and a rejected initializeFaro that reuses a FetchTransport does not take over its storing', async () => {
    const reusedUrl = 'http://reused.test/collect';
    const reused = new FetchTransport({ url: reusedUrl });
    const first = offlineTransport();
    // Not isolated: registered globally, as in an app.
    const { faro } = await init({ transports: [first, reused], isolate: false, ignoreUrls: [reusedUrl] });
    await flush();
    const firstStore = reused.getOfflineStore();
    expect(firstStore).not.toBeNull();

    for (const [prefix, disposeRejected] of [
      ['second', false],
      ['third', true],
    ] as const) {
      const rejected = new OfflineTransport({ storageKeyPrefix: prefix });
      created.push(rejected);
      await expect(
        initializeFaro({
          ...mockConfig({ sessionTracking: { enabled: true, persistent: false } }),
          isolate: false,
          url: COLLECTOR_URL,
          ignoreUrls: [reusedUrl],
          unpatchedConsole: { ...console, warn: jest.fn() },
          transports: [rejected, reused],
        } as Parameters<typeof initializeFaro>[0])
      ).resolves.toBeUndefined();
      if (disposeRejected) {
        rejected.dispose();
      }
      expect(faro.transports.transports.filter((t) => t instanceof OfflineTransport)).toEqual([first]);
      expect(reused.getOfflineStore()).toBe(firstStore);

      const message = `after ${prefix} init`;
      setOnline(false);
      faro.api.pushLog([message]);
      await flush();
      expect(entryKeys(`${prefix}_e_`)).toEqual([]);
      setOnline(true);
      await flush();

      expect(loggedMessages(reusedUrl).filter((m) => m === message)).toHaveLength(1);
      expect(await first.getCachedCount()).toBe(0);
    }
  });

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
    expect(entryKeys('custom_prefix_e_')).toHaveLength(1);
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

  it.each([
    ['faro-core initializeFaro', false],
    ['the binding of this package', true],
  ])(
    'with %s, stores telemetry captured offline for a FetchTransport that is only passed to setOtherTransports',
    async (_name, bind) => {
      const offline = offlineTransport();
      offline.setOtherTransports([new FetchTransport({ url: COLLECTOR_URL })]);
      const faro = initCore([offline], {}, bind);
      await flush();

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      expect(cachedMessages()).toEqual([['while offline']]);

      setOnline(true);
      await flush();
      if (!bind) {
        // Without the binding, replay starts with forceReplay() or after an accepted live request.
        await offline.forceReplay();
      }

      expect(loggedMessages()).toEqual(['while offline']);
      expect(await offline.getCachedCount()).toBe(0);
    }
  );

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
    await flush();

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
    await flush();
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
    const cache = (offline as unknown as { cache: { writeMany(p: CachedPayload[]): Promise<void> } }).cache;
    await cache.writeMany([{ timestamp: Date.now(), items: [log('C')] }]);
    await cache.writeMany([{ timestamp: Date.now(), items: [log('D')] }]);
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
    await flush();

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
      await flush();
      setOnline(false);
      // One cache entry each.
      for (const message of ['1', '2', '3']) {
        faro.api.pushLog([message]);
        await flush();
      }
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

    it('stops replaying when NetInfo reports offline mid-replay, and resumes when it reports online', async () => {
      const offline = await cacheThree();
      fetchMock.mockImplementationOnce(() => {
        setOnline(false);
        return response(202);
      });

      setOnline(true);
      await flush();

      expect(loggedMessages()).toEqual(['1']);
      expect(cachedMessages()).toEqual([['2'], ['3']]);

      setOnline(true);
      await flush();
      expect(loggedMessages()).toEqual(['1', '2', '3']);
      expect(await offline.getCachedCount()).toBe(0);
    });
  });

  describe('ordering', () => {
    it('keeps capture order when metas alternate within one send', async () => {
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
      initCore([offline, fetchTransport]);
      await flush();
      setOnline(false);

      await fetchTransport.send([
        log('1', { user: { id: 'a' } }),
        log('2', { user: { id: 'b' } }),
        log('3', { user: { id: 'a' } }),
      ]);
      await flush();
      expect(cachedMessages()).toEqual([['1', '2', '3']]);

      setOnline(true);
      await flush();

      expect(requests()).toHaveLength(3);
      expect(loggedMessages()).toEqual(['1', '2', '3']);
    });

    it('keeps capture order across overlapping sends', async () => {
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
      initCore([offline, fetchTransport]);
      await flush();
      setOnline(false);

      const first = fetchTransport.send([log('A', { user: { id: 'a' } }), log('B', { user: { id: 'b' } })]);
      const second = fetchTransport.send([log('C', { user: { id: 'a' } })]);
      await Promise.all([first, second]);
      await flush();

      // One entry per send, in storage order.
      expect(cachedMessages()).toEqual([['A', 'B'], ['C']]);
    });

    it('replays in storage order when an earlier live request fails after a later one was stored and replayed', async () => {
      const resolvers: Array<(value: unknown) => void> = [];
      const accepted: string[] = [];
      let mode: 'hang' | 'fail' | 'ok' = 'hang';
      fetchMock.mockImplementation((_url, init) => {
        const messages = ((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message);
        if (mode === 'hang') {
          return new Promise((resolve) => resolvers.push(resolve)) as any;
        }
        if (mode === 'fail') {
          return Promise.reject(new Error('down')) as any;
        }
        accepted.push(...messages);
        return response(202);
      });
      const offline = offlineTransport();
      const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
      initCore([offline, fetchTransport]);
      await flush();

      // A is in flight; B fails at once and is stored, then replayed.
      const first = fetchTransport.send([log('A')]);
      await flush();
      mode = 'fail';
      await fetchTransport.send([log('B')]);
      await flush();
      expect(cachedMessages()).toEqual([['B']]);
      mode = 'ok';
      await offline.forceReplay();
      expect(accepted).toEqual(['B']);

      // A fails late: it is stored after B and replayed after it.
      mode = 'fail';
      resolvers.forEach((resolve) => resolve(Promise.reject(new Error('timeout'))));
      await first;
      await flush();
      expect(cachedMessages()).toEqual([['A']]);
      mode = 'ok';
      await offline.forceReplay();
      expect(accepted).toEqual(['B', 'A']);
      expect(cachedPayloads()).toEqual([]);
    });
  });

  describe('real FetchTransport backoff and buffer', () => {
    it('keeps payloads without a request while the circuit breaker is open, then delivers', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);

      // Three failed live sends open the circuit breaker for 30 s; they are stored.
      fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
      faro.api.pushLog(['live 1']);
      faro.api.pushLog(['live 2']);
      faro.api.pushLog(['live 3']);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // One entry per failed send.
      expect(cachedMessages()).toEqual([['live 1'], ['live 2'], ['live 3']]);

      fetchMock.mockReset();
      fetchMock.mockImplementation(() => response(202));
      faro.api.pushLog(['during backoff']);
      await flush();
      await offline.forceReplay();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await offline.getCachedCount()).toBe(4);

      await jest.advanceTimersByTimeAsync(31_000);
      await flush();

      expect(loggedMessages()).toEqual(['live 1', 'live 2', 'live 3', 'during backoff']);
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
      await flush();
      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      // Removing the delivered entry fails.
      (AsyncStorage.multiRemove as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('disk full')));
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
      await flush();
      setOnline(false);
      faro.api.pushLog(['a']);
      await flush();
      faro.api.pushLog(['b']);
      await flush();
      expect(cachedMessages()).toEqual([['a'], ['b']]);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      (AsyncStorage.multiGet as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
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

    it('keeps undelivered entries when saving progress fails', async () => {
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      await flush();
      setOnline(false);
      faro.api.pushLog(['a']);
      await flush();
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
      // Saving progress at the end of the pass cannot remove the delivered entry.
      (AsyncStorage.multiRemove as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('storage busy')));
      setOnline(true);
      await flush();

      expect(loggedMessages()).toEqual(['a', 'b']);
      // Progress for 'a' was not saved, and 'b' was not lost.
      expect(await offline.getCachedCount()).toBe(2);

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
      await flush();
      setOnline(false);

      (AsyncStorage.multiSet as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('disk full')));
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
      expect(JSON.stringify(mockStore)).not.toContain('secret-app-token');
      expect(JSON.stringify(mockStore)).not.toContain('faro-collector.test');
    });

    it('saves replay progress in chunks instead of rewriting the cache after every entry', async () => {
      const now = Date.now();
      seedEntries(Array.from({ length: 120 }, (_, i) => ({ timestamp: now, items: [log(String(i))] })));
      const multiSet = AsyncStorage.multiSet as jest.Mock;
      const multiRemove = AsyncStorage.multiRemove as jest.Mock;
      multiSet.mockClear();
      multiRemove.mockClear();
      const offline = offlineTransport();
      initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      await flush();
      await offline.forceReplay();

      expect(loggedMessages()).toHaveLength(120);
      expect(cachedPayloads()).toEqual([]);
      // 120 entries, saved every 50 and at the end.
      expect(multiSet.mock.calls.length + multiRemove.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });
});

/** Settles promises without writing collected items, unlike `flush()`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

describe('storing on failed live sends', () => {
  /** Collector stub: answers with `status`, records messages it accepted. */
  function collector(initialStatus: number, headers: Record<string, string> = {}) {
    const state = { status: initialStatus, accepted: [] as string[] };
    fetchMock.mockImplementation((_url, init) => {
      if (state.status >= 200 && state.status < 300) {
        state.accepted.push(...((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message));
      }
      return Promise.resolve({
        status: state.status,
        text: () => Promise.resolve(''),
        headers: { get: (name: string) => headers[name] ?? null },
      });
    });
    return state;
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  it('stores telemetry the collector answers with 503 while online, and delivers it once when it recovers', async () => {
    const server = collector(503);
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    faro.api.pushLog(['during outage 1']);
    await flush();
    faro.api.pushLog(['during outage 2']);
    await flush();
    expect(cachedMessages()).toEqual([['during outage 1'], ['during outage 2']]);

    server.status = 202;
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(server.accepted).toEqual(['during outage 1', 'during outage 2']);
    expect(cachedPayloads()).toEqual([]);

    // Nothing is sent again later.
    await jest.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(server.accepted).toEqual(['during outage 1', 'during outage 2']);
  });

  it('stores telemetry whose request fails although connectivity looks fine, and replays it after the next accepted send', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('collector unreachable')));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    faro.api.pushLog(['lost on main']);
    await flush();
    expect(cachedMessages()).toEqual([['lost on main']]);

    const server = collector(202);
    faro.api.pushLog(['live again']);
    await flush();

    expect(server.accepted).toEqual(['live again', 'lost on main']);
    expect(cachedPayloads()).toEqual([]);
    expect(fetchMock.mock.calls.every(([url]) => url === COLLECTOR_URL)).toBe(true);
  });

  it('drops live telemetry rejected with a non-retryable status instead of storing it', async () => {
    collector(400);
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    faro.api.pushLog(['bad']);
    await flush();

    expect(await offline.getCachedCount()).toBe(0);
  });

  it('keeps to Retry-After after a 429: stores without requests, then delivers once', async () => {
    const server = collector(429, { 'Retry-After': '20' });
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    faro.api.pushLog(['a']);
    await flush();
    server.status = 202;
    faro.api.pushLog(['b']);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedMessages().flat()).toEqual(['a', 'b']);

    await jest.advanceTimersByTimeAsync(19_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(server.accepted).toEqual(['a', 'b']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('writes each failed send as its own entry right away, and items stored during a write with the next write', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await settle();
    const multiSet = AsyncStorage.multiSet as jest.Mock;
    let releaseFirst: () => void = () => {};
    multiSet.mockImplementationOnce((pairs: Array<[string, string]>) => {
      return new Promise<void>((resolve) => {
        releaseFirst = () => {
          pairs.forEach(([key, value]) => (mockStore[key] = value));
          resolve();
        };
      });
    });
    multiSet.mockClear();

    faro.api.pushLog(['item 0']);
    await settle();
    // Written without waiting for more.
    expect(multiSet).toHaveBeenCalledTimes(1);

    for (let i = 1; i < 10; i++) {
      faro.api.pushLog([`item ${i}`]);
      await settle();
    }
    expect(multiSet).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flush();

    expect(multiSet).toHaveBeenCalledTimes(2);
    expect(cachedMessages()).toEqual(Array.from({ length: 10 }, (_, i) => [`item ${i}`]));
  });

  it('can store the same items again after a cache write failed', async () => {
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();
    setOnline(false);
    (AsyncStorage.multiSet as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('disk full')));

    const items = [log('retry me')];
    await fetchTransport.send(items);
    await flush();
    expect(cachedPayloads()).toEqual([]);

    await fetchTransport.send(items);
    await flush();
    expect(cachedMessages()).toEqual([['retry me']]);
  });

  it('still writes items handed over just before dispose(), including ones queued behind a write', async () => {
    const offline = new OfflineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();
    setOnline(false);
    let releaseFirst: () => void = () => {};
    (AsyncStorage.multiSet as jest.Mock).mockImplementationOnce(
      (pairs: Array<[string, string]>) =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            pairs.forEach(([key, value]) => (mockStore[key] = value));
            resolve();
          };
        })
    );

    await fetchTransport.send([log('first')]);
    await fetchTransport.send([log('second')]);
    offline.dispose();
    // Detached: nothing new is handed over.
    expect(fetchTransport.getOfflineStore()).toBeNull();
    await settle();
    releaseFirst();

    expect(await offline.getCachedCount()).toBe(2);
    expect(cachedMessages()).toEqual([['first'], ['second']]);
  });

  it('replays entries stored while a replay pass was running', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([{ timestamp: Date.now(), items: [log('old')] }]);
    let releaseOld: () => void = () => {};
    const accepted: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const messages = ((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message);
      if (messages.includes('old') && accepted.length === 0) {
        return new Promise((resolve) => {
          releaseOld = () => {
            accepted.push(...messages);
            resolve(response(202));
          };
        }) as any;
      }
      accepted.push(...messages);
      return response(202);
    });
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();

    // Stored during the pass that is sending 'old'.
    setOnline(false);
    await fetchTransport.send([log('new')]);
    setOnline(true);
    await flush();
    releaseOld();
    await flush();

    expect(accepted).toEqual(['old', 'new']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('replays when the app returns to the foreground', async () => {
    const listeners: Array<(state: string) => void> = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _event: string,
      listener: (state: string) => void
    ) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    }) as any);
    try {
      fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
      const offline = offlineTransport();
      const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
      await settle();

      faro.api.pushLog(['before background']);
      await flush();
      expect(cachedMessages()).toEqual([['before background']]);

      const server = collector(202);
      listeners.forEach((listener) => listener('active'));
      await flush();
      expect(server.accepted).toEqual(['before background']);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps sending live through a registered FetchTransport after setOtherTransports() replaces it with another transport', async () => {
    const custom = voidTransport('custom');
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    const faro = initCore([offline, fetchTransport]);
    await flush();
    offline.setOtherTransports([custom]);
    setOnline(false);

    faro.api.pushLog(['live']);
    await flush();
    setOnline(true);
    await flush();

    expect(loggedMessages()).toEqual(['live']);
    expect(fetchTransport.getOfflineStore()).toBeNull();
  });

  it('stores for each collector URL only what that collector did not accept', async () => {
    const otherUrl = 'http://other-collector.test/collect';
    let otherDown = true;
    const accepted: Record<string, string[]> = { [COLLECTOR_URL]: [], [otherUrl]: [] };
    fetchMock.mockImplementation((url, init) => {
      if (url === otherUrl && otherDown) {
        return Promise.reject(new Error('down')) as any;
      }
      accepted[url]?.push(...((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message));
      return response(202);
    });
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL }), new FetchTransport({ url: otherUrl })]);
    await flush();

    faro.api.pushLog(['once each']);
    await flush();
    expect(accepted).toEqual({ [COLLECTOR_URL]: ['once each'], [otherUrl]: [] });

    otherDown = false;
    await offline.forceReplay();

    expect(accepted).toEqual({ [COLLECTOR_URL]: ['once each'], [otherUrl]: ['once each'] });
    expect(cachedPayloads()).toEqual([]);
  });
});

describe('paused Faro', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  it('does not replay while paused from init, and delivers once soon after unpause', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([{ timestamp: Date.now(), items: [log('from last run')] }]);
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })], { paused: true });
    await flush();
    await offline.forceReplay();
    setOnline(true);
    await jest.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await offline.getCachedCount()).toBe(1);

    faro.unpause();
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(loggedMessages()).toEqual(['from last run']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('stops replaying after faro.pause()', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    setOnline(false);
    faro.api.pushLog(['stored']);
    await flush();

    faro.pause();
    setOnline(true);
    await offline.forceReplay();
    await jest.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachedMessages()).toEqual([['stored']]);
  });
});

describe('paused Faro during replay', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  it('stops before the next request when paused between metadata groups of one payload, and resumes after unpause', async () => {
    mockStore[CACHE_KEY] = JSON.stringify([
      { timestamp: Date.now(), items: [log('1', { user: { id: 'a' } }), log('2', { user: { id: 'b' } })] },
    ]);
    let faro: Faro | undefined;
    fetchMock.mockImplementation(() => {
      faro?.pause();
      return response(202);
    });
    const offline = offlineTransport();
    faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })], { paused: true });
    faro.unpause();
    await offline.forceReplay();
    await flush();

    expect(loggedMessages()).toEqual(['1']);
    expect(cachedMessages()).toEqual([['1', '2']]);

    fetchMock.mockImplementation(() => response(202));
    faro.unpause();
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(loggedMessages()).toEqual(['1', '2']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('stops before the next destination when paused after the first one', async () => {
    const otherUrl = 'http://other-collector.test/collect';
    mockStore[CACHE_KEY] = JSON.stringify([{ timestamp: Date.now(), items: [log('x')] }]);
    let faro: Faro | undefined;
    fetchMock.mockImplementation(() => {
      faro?.pause();
      return response(202);
    });
    const offline = offlineTransport();
    faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL }), new FetchTransport({ url: otherUrl })], {
      paused: true,
    });
    faro.unpause();
    await offline.forceReplay();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends items stored while paused soon after unpause', async () => {
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    const faro = initCore([offline, fetchTransport]);
    await flush();
    faro.pause();
    setOnline(false);
    // A live send that was running when Faro was paused.
    await fetchTransport.send([log('stored while paused')]);
    await flush();
    setOnline(true);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    faro.unpause();
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(loggedMessages()).toEqual(['stored while paused']);
  });
});

describe('paused Faro with a long retry delay', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  it('sends items stored while paused soon after unpause, although a longer retry delay was running', async () => {
    let status = 503;
    fetchMock.mockImplementation(() => response(status));
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    const faro = initCore([offline, fetchTransport]);
    await flush();

    faro.api.pushLog(['before pause']);
    await flush();
    // Failed replays grow the retry delay to 60 s (four replay rejections, below the drop limit).
    for (const delay of [5_000, 5_000, 15_000, 30_000]) {
      await jest.advanceTimersByTimeAsync(delay);
      await flush();
    }
    const failedRequests = fetchMock.mock.calls.length;
    expect(failedRequests).toBe(5);

    faro.pause();
    // A live send that was running when Faro was paused is stored without a request.
    await fetchTransport.send([log('stored while paused')]);
    await flush();
    expect(cachedMessages()).toEqual([['before pause'], ['stored while paused']]);

    status = 202;
    faro.unpause();
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(fetchMock.mock.calls.length).toBe(failedRequests + 2);
    expect(loggedMessages().slice(-2)).toEqual(['before pause', 'stored while paused']);
    expect(cachedPayloads()).toEqual([]);
  });
});

describe('deprecated connectivityCheckIntervalMs', () => {
  it('is accepted and warns once', () => {
    const warn = jest.spyOn(defaultUnpatchedConsole, 'warn').mockImplementation(() => {});
    try {
      created.push(new OfflineTransport());
      expect(warn).not.toHaveBeenCalled();
      created.push(new OfflineTransport({ connectivityCheckIntervalMs: 10_000 }));
      created.push(new OfflineTransport({ connectivityCheckIntervalMs: 10_000 }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('connectivityCheckIntervalMs');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('reconnect recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  function replayState(offline: OfflineTransport): { retryAttempt: number } {
    return offline as unknown as { retryAttempt: number };
  }

  it('does not send failures from before a reconnect into a backoff: the first send after it goes out at once', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('no route')));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    // Fail before NetInfo notices: three failures open the circuit breaker for 30 s.
    for (const message of ['1', '2', '3']) {
      faro.api.pushLog([message]);
      await flush();
    }
    setOnline(false);
    faro.api.pushLog(['offline']);
    await flush();
    expect(cachedMessages()).toEqual([['1'], ['2'], ['3'], ['offline']]);

    fetchMock.mockClear();
    fetchMock.mockImplementation(() => response(202));
    setOnline(true);
    await flush();

    expect(loggedMessages()).toEqual(['1', '2', '3', 'offline']);
    expect(cachedPayloads()).toEqual([]);
  });

  it('keeps a 429 Retry-After backoff across a reconnect', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ status: 429, text: () => Promise.resolve(''), headers: { get: () => '60' } })
    );
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    faro.api.pushLog(['limited']);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(() => response(202));
    setOnline(false);
    setOnline(true);
    await flush();
    await jest.advanceTimersByTimeAsync(58_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await jest.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(loggedMessages()).toEqual(['limited']);
  });

  it('does not read the cache, send, or arm a timer while NetInfo reports offline', async () => {
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    setOnline(false);
    faro.api.pushLog(['offline']);
    await flush();
    const getAllKeys = AsyncStorage.getAllKeys as jest.Mock;
    getAllKeys.mockClear();

    await offline.forceReplay();
    await jest.advanceTimersByTimeAsync(600_000);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAllKeys).not.toHaveBeenCalled();
    expect(replayState(offline).retryAttempt).toBe(0);
    expect(jest.getTimerCount()).toBe(0);

    setOnline(true);
    await flush();
    expect(loggedMessages()).toEqual(['offline']);
  });

  it('lets a retry timer that fires while offline do nothing, without growing the retry delay', async () => {
    fetchMock.mockImplementation(() => response(503));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    faro.api.pushLog(['kept']);
    await flush();
    expect(cachedMessages()).toEqual([['kept']]);
    const attempt = replayState(offline).retryAttempt;

    setOnline(false);
    fetchMock.mockClear();
    await jest.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replayState(offline).retryAttempt).toBe(attempt);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a pass skipped during backoff when the backoff ends, without growing the retry delay', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    // Three failed live sends open the breaker for 30 s; storing arms the 5 s retry.
    for (const message of ['1', '2', '3']) {
      faro.api.pushLog([message]);
    }
    await flush();
    fetchMock.mockClear();
    fetchMock.mockImplementation(() => response(202));

    // The 5 s retry is skipped (backoff) and does not grow the delay.
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replayState(offline).retryAttempt).toBe(0);

    await jest.advanceTimersByTimeAsync(26_000);
    await flush();
    expect(loggedMessages()).toEqual(['1', '2', '3']);
  });

  it('waits for the first NetInfo answer before the startup replay, so an offline cold start sends nothing', async () => {
    seedEntries([{ timestamp: Date.now(), items: [log('from last run')] }]);
    let answer: () => void = () => {};
    mockKnown = new Promise((resolve) => (answer = resolve));
    const offline = offlineTransport();
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(false);
    answer();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    await flush();
    expect(loggedMessages()).toEqual(['from last run']);
  });

  it('replays at startup after at most about a second when NetInfo does not answer', async () => {
    seedEntries([{ timestamp: Date.now(), items: [log('from last run')] }]);
    mockKnown = new Promise(() => {});
    const offline = offlineTransport();
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(loggedMessages()).toEqual(['from last run']);
  });

  it('replays at once after an accepted live send following unpause, although a 300 s retry delay was running', async () => {
    let status = 503;
    fetchMock.mockImplementation(() => response(status));
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    replayState(offline).retryAttempt = 5;
    faro.api.pushLog(['cached']);
    await flush();
    await offline.forceReplay();
    await flush();
    expect(await offline.getCachedCount()).toBe(1);

    faro.pause();
    await flush();
    faro.unpause();
    fetchMock.mockClear();
    status = 202;
    faro.api.pushLog(['live']);
    await flush();

    expect(loggedMessages()).toEqual(['live', 'cached']);
    expect(await offline.getCachedCount()).toBe(0);
  });
});

describe('storage limits and poison entries', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  it('does not store an item larger than 256 KB, with a warning', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    const offline = offlineTransport();
    const warn = jest.spyOn(offline as unknown as { logWarn: (m: string) => void }, 'logWarn');
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();

    await fetchTransport.send([log('x'.repeat(300 * 1024)), log('small')]);
    await flush();

    expect(cachedMessages()).toEqual([['small']]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('larger than'));
  });

  it('writes payloads queued during a write in chunks of about 128 KB', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();
    const multiSet = AsyncStorage.multiSet as jest.Mock;
    let releaseFirst: () => void = () => {};
    multiSet.mockImplementationOnce(
      (pairs: Array<[string, string]>) =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            pairs.forEach(([key, value]) => (mockStore[key] = value));
            resolve();
          };
        })
    );
    multiSet.mockClear();

    for (let i = 0; i < 10; i++) {
      await fetchTransport.send([log(`${i}`.padEnd(40_000, '.'))]);
    }
    await settle();
    expect(multiSet).toHaveBeenCalledTimes(1);
    releaseFirst();
    await flush();

    const later = multiSet.mock.calls.slice(1) as Array<[Array<[string, string]>]>;
    expect(later.length).toBeGreaterThan(1);
    later.forEach(([pairs]) => {
      expect(pairs.reduce((sum, [, value]) => sum + value.length, 0)).toBeLessThanOrEqual(128 * 1024);
    });
    expect(cachedPayloads()).toHaveLength(10);
  });

  it('evicts the oldest entries beyond maxCacheBytes when storing', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    const offline = new OfflineTransport({ maxCacheBytes: 100_000 });
    created.push(offline);
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();

    for (let i = 0; i < 5; i++) {
      await fetchTransport.send([log(`${i}`.padEnd(30_000, '.'))]);
      await flush();
    }

    expect(cachedMessages().map(([message]) => message?.[0])).toEqual(['2', '3', '4']);
  });

  it('drops an entry with five retryable rejections once the first is over an hour old, with a warning', async () => {
    seedEntries([{ timestamp: Date.now(), items: [log('poison')] }]);
    fetchMock.mockImplementation(() => response(503));
    const offline = offlineTransport();
    const warn = jest.spyOn(offline as unknown as { logWarn: (m: string) => void }, 'logWarn');
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    const firstRejection = Date.now();
    for (let i = 0; i < 5; i++) {
      await offline.forceReplay();
    }
    // Six rejections, but within the hour.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(cachedPayloads()[0]).toMatchObject({ rejections: 6, firstRejectedAt: firstRejection });

    jest.setSystemTime(Date.now() + 59 * 60 * 1000);
    await offline.forceReplay();
    expect(await offline.getCachedCount()).toBe(1);

    jest.setSystemTime(Date.now() + 2 * 60 * 1000);
    await offline.forceReplay();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(cachedPayloads()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('8 retryable rejections'));
  });

  it('keeps every entry through a two-minute 5xx outage and delivers them after it', async () => {
    let status = 503;
    const accepted: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      if (status === 202) {
        accepted.push(...((JSON.parse(init.body) as Body).logs ?? []).map((l) => l.message));
      }
      return response(status);
    });
    const offline = offlineTransport();
    const faro = initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    faro.api.pushLog(['oldest']);
    await flush();
    for (let second = 0; second < 120; second += 5) {
      await jest.advanceTimersByTimeAsync(5_000);
      await flush();
      faro.api.pushLog([`at ${second + 5} s`]);
      await flush();
    }
    expect(cachedPayloads()[0]?.rejections).toBeGreaterThanOrEqual(5);

    status = 202;
    await jest.advanceTimersByTimeAsync(300_000);
    await flush();

    expect(accepted.filter((m) => m === 'oldest')).toHaveLength(1);
    expect(accepted.filter((m) => m.startsWith('at '))).toHaveLength(24);
    expect(cachedPayloads()).toEqual([]);
  });

  it('starts the hour at the next rejection for entries stored without a first-rejection time', async () => {
    seedEntries([{ timestamp: Date.now(), items: [log('old format')], rejections: 7 }]);
    fetchMock.mockImplementation(() => response(503));
    const offline = offlineTransport();
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();
    expect(cachedPayloads()[0]).toMatchObject({ rejections: 8, firstRejectedAt: Date.now() });

    jest.setSystemTime(Date.now() + 61 * 60 * 1000);
    await offline.forceReplay();
    expect(cachedPayloads()).toEqual([]);
  });

  it('does not count 429 or failed requests toward the rejection limit', async () => {
    seedEntries([{ timestamp: Date.now(), items: [log('limited')] }]);
    let attempt = 0;
    fetchMock.mockImplementation(() =>
      attempt++ % 2 === 0
        ? (Promise.resolve({ status: 429, text: () => Promise.resolve(''), headers: { get: () => '0' } }) as any)
        : (Promise.reject(new Error('down')) as any)
    );
    const offline = offlineTransport();
    const fetchTransport = new FetchTransport({ url: COLLECTOR_URL });
    initCore([offline, fetchTransport]);
    await flush();
    for (let i = 0; i < 6; i++) {
      fetchTransport.resetFailureBackoff();
      await offline.forceReplay();
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(cachedMessages()).toEqual([['limited']]);
    expect(cachedPayloads()[0]?.rejections).toBeUndefined();
  });
});

describe('malformed cache entries', () => {
  it('removes an entry whose items are not transport items and replays the ones after it', async () => {
    const good = JSON.stringify({ items: [log('after')] });
    const now = Date.now();
    mockStore[`${ENTRY_PREFIX}000001000000_${now}_16`] = '{"items":[null]}';
    mockStore[`${ENTRY_PREFIX}000001000001_${now}_${good.length}`] = good;
    const offline = offlineTransport();
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    expect(loggedMessages()).toEqual(['after']);
    expect(Object.keys(mockStore)).toEqual([]);
  });

  it('drops an entry no request can be built from, with a warning, and replays the ones after it', async () => {
    const trace = (scopeSpans: unknown) =>
      ({ type: 'trace', payload: { resourceSpans: [{ scopeSpans }] }, meta: {} }) as unknown as TransportItem;
    seedEntries([
      { timestamp: Date.now(), items: [trace(5), trace([])] },
      { timestamp: Date.now(), items: [log('after')] },
    ]);
    const offline = offlineTransport();
    const warn = jest.spyOn(offline as unknown as { logWarn: (m: string) => void }, 'logWarn');
    initCore([offline, new FetchTransport({ url: COLLECTOR_URL })]);
    await flush();

    expect(loggedMessages()).toEqual(['after']);
    expect(await offline.getCachedCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be sent'));
  });

  it('drops an entry after an explicit transport threw for it five times over more than an hour', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const custom = voidTransport('custom');
    custom.send.mockImplementation(() => {
      throw new Error('boom');
    });
    const offline = offlineTransport();
    initCore([offline]);
    offline.setOtherTransports([custom]);
    setOnline(false);
    await offline.send([log('x')]);
    setOnline(true);
    await flush();
    for (let i = 0; i < 3; i++) {
      await offline.forceReplay();
    }
    expect(await offline.getCachedCount()).toBe(1);

    jest.setSystemTime(Date.now() + 61 * 60 * 1000);
    await offline.forceReplay();
    expect(custom.send).toHaveBeenCalledTimes(5);
    expect(await offline.getCachedCount()).toBe(0);
  });
});
