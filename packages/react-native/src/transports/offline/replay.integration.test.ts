import type { Faro, TransportItem } from '@grafana/faro-core';

import { initializeFaro } from '../../initialize';
import * as sessionAttributes from '../../instrumentations/session/sessionAttributes';
import * as appBuildIdentity from '../../metas/appBuildIdentity';
import { FetchTransport } from '../fetch';

import { OfflineTransport } from './transport';

jest.mock('../../config/getRNInstrumentations', () => ({ getRNInstrumentations: () => [] }));

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
      return () => mockSubscribers.delete(callback);
    }
    dispose() {}
  },
}));

const COLLECTOR_URL = 'http://collector.test/collect';

function setOnline(isOnline: boolean): void {
  mockOnline = isOnline;
  mockSubscribers.forEach((subscriber) => subscriber(isOnline));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fetchMock = jest.fn((_url: string, _init: { body: string; headers: Record<string, string> }) =>
  Promise.resolve({ status: 202, text: () => Promise.resolve(''), headers: { get: () => null } })
);

type Body = { logs?: Array<{ message: string; context?: Record<string, string> }> };

function deliveredLogs(): Array<{ message: string; context?: Record<string, string>; apiKey?: string }> {
  return fetchMock.mock.calls.flatMap(([, init]) =>
    ((JSON.parse(init.body) as Body).logs ?? []).map((entry) => ({ ...entry, apiKey: init.headers['x-api-key'] }))
  );
}

// Appends "x" to context.hooked, so running the hook twice is visible in the delivered item.
const transformingBeforeSend = jest.fn((item: TransportItem) => ({
  ...item,
  payload: {
    ...item.payload,
    context: { hooked: `${(item.payload as { context?: { hooked?: string } }).context?.hooked ?? ''}x` },
  },
}));

const originalFetch = global.fetch;
const cleanups: Array<() => void> = [];
let mobileSpy: jest.SpyInstance;
let bundleSpy: jest.SpyInstance;

beforeEach(() => {
  mockStore = {};
  mockOnline = true;
  mockSubscribers.clear();
  fetchMock.mockClear();
  transformingBeforeSend.mockClear();
  (global as any).fetch = fetchMock;
  mobileSpy = jest.spyOn(sessionAttributes, 'loadMobileMetaForInit').mockResolvedValue({
    sessionAttributes: sessionAttributes.minimalSessionDeviceAttributes(),
    meta: {},
  });
  bundleSpy = jest.spyOn(appBuildIdentity, 'loadAppSymbolsBundleIdForInit').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  mobileSpy.mockRestore();
  bundleSpy.mockRestore();
  (global as any).fetch = originalFetch;
});

async function init(
  config: Partial<Parameters<typeof initializeFaro>[0]>
): Promise<{ faro: Faro; offline: OfflineTransport }> {
  const faro = await initializeFaro({
    url: COLLECTOR_URL,
    app: { name: 'test' },
    isolate: true,
    sessionTracking: { enabled: false },
    ...config,
  } as Parameters<typeof initializeFaro>[0]);
  const offlines = faro.transports.transports.filter((t): t is OfflineTransport => t instanceof OfflineTransport);
  cleanups.push(() => {
    faro.pause();
    offlines.forEach((offline) => offline.dispose());
  });
  expect(offlines).toHaveLength(1);
  const offline = offlines[0];
  if (!offline) {
    throw new Error('no offline transport');
  }
  return { faro, offline };
}

describe('offline replay through initializeFaro', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'delivers cached items once, processed once (batching=%s, manual OfflineTransport=%s)',
    async (batching, manual) => {
      const supplied = manual ? new OfflineTransport() : undefined;
      const { faro, offline } = await init({
        enableTransports: { offline: !manual },
        transports: supplied ? [supplied] : [],
        beforeSend: transformingBeforeSend,
        batching: { enabled: batching, sendTimeout: 10 },
      });
      if (supplied) {
        expect(offline).toBe(supplied);
      }

      setOnline(false);
      faro.api.pushLog(['while offline']);
      await flush();
      expect(await offline.getCachedCount()).toBe(1);
      // Cached items are not also sent live.
      expect(fetchMock).not.toHaveBeenCalled();
      const hookCalls = transformingBeforeSend.mock.calls.length;
      expect(hookCalls).toBeGreaterThan(0);

      setOnline(true);
      await flush();
      await offline.forceReplay();

      expect(deliveredLogs().filter((entry) => entry.message === 'while offline')).toEqual([
        expect.objectContaining({ context: { hooked: 'x' } }),
      ]);
      expect(transformingBeforeSend).toHaveBeenCalledTimes(hookCalls);
      expect(await offline.getCachedCount()).toBe(0);
      expect(faro.transports.transports.filter((t) => t instanceof FetchTransport)).toHaveLength(1);
      expect(faro.transports.transports.flatMap((t) => t.getIgnoreUrls())).toContain(COLLECTOR_URL);
    }
  );

  it('keeps one offline transport when one is also supplied, so a payload is replayed once', async () => {
    const supplied = new OfflineTransport();
    const dispose = jest.spyOn(supplied, 'dispose');
    const { faro, offline } = await init({ enableTransports: { offline: true }, transports: [supplied] });
    expect(offline).not.toBe(supplied);
    expect(dispose).toHaveBeenCalled();

    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    setOnline(true);
    await flush();
    await offline.forceReplay();
    await supplied.forceReplay();

    expect(deliveredLogs().map((entry) => entry.message)).toEqual(['while offline']);
  });

  it('uses the supplied FetchTransport for the same URL for live sends and replay', async () => {
    const userFetch = new FetchTransport({ url: COLLECTOR_URL, apiKey: 'user-key' });
    const { faro, offline } = await init({ enableTransports: { offline: true }, transports: [userFetch] });
    expect(faro.transports.transports.filter((t) => t instanceof FetchTransport)).toEqual([userFetch]);

    faro.api.pushLog(['live']);
    await flush();
    setOnline(false);
    faro.api.pushLog(['while offline']);
    await flush();
    setOnline(true);
    await flush();
    await offline.forceReplay();

    expect(deliveredLogs().map(({ message, apiKey }) => ({ message, apiKey }))).toEqual([
      { message: 'live', apiKey: 'user-key' },
      { message: 'while offline', apiKey: 'user-key' },
    ]);
  });
});
