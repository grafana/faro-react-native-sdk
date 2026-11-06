import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { BaseTransport, LogLevel, TransportItemType, VERSION } from '@grafana/faro-core';
import type { LogEvent, Transport, TransportItem } from '@grafana/faro-core';

import { initializeFaro } from '../../initialize';
import { FetchTransport } from '../fetch';

import { AsyncStorageOfflineCache } from './OfflineCache';
import { OfflineTransport } from './transport';
import type { ConnectivityService } from './types';

const mockSubscribers = new Set<(isOnline: boolean) => void>();
const mockConnectivity: ConnectivityService & { isOnline: boolean } = {
  isOnline: false,
  subscribe: jest.fn((callback: (isOnline: boolean) => void) => {
    mockSubscribers.add(callback);
    callback(mockConnectivity.isOnline);
    return () => {
      mockSubscribers.delete(callback);
    };
  }),
  dispose: jest.fn(),
};

jest.mock('./ConnectivityService', () => ({
  DefaultConnectivityService: jest.fn(() => mockConnectivity),
}));

// Keep SDK initialization, metadata, transport fan-out, persistence, and FetchTransport
// real; native instrumentation signals are unrelated to offline delivery.
jest.mock('../../config/getRNInstrumentations', () => ({ getRNInstrumentations: () => [] }));

const collectorUrl = 'https://collector.example.com/collect';
const item: TransportItem<LogEvent> = {
  type: TransportItemType.LOG,
  payload: {
    context: {},
    message: 'cached before restart',
    level: LogLevel.INFO,
    timestamp: '2026-10-15T00:00:00.000Z',
  },
  meta: { session: { id: 'original-session' } },
};
const response = (status: number) => ({
  status,
  text: async () => '',
  headers: { get: () => null },
});
const settleReplay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('configured offline replay', () => {
  let originalFetch: typeof global.fetch;
  let collectorFetch: jest.Mock;
  let offlineTransports: OfflineTransport[];

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' });
    originalFetch = global.fetch;
    collectorFetch = jest.fn().mockResolvedValue(response(202));
    global.fetch = collectorFetch;
    offlineTransports = [];
    mockConnectivity.isOnline = false;
    mockSubscribers.clear();
  });

  afterEach(() => {
    offlineTransports.forEach((transport) => transport.dispose());
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete (globalThis as Record<string, unknown>)['faro'];
  });

  async function initialize(extraTransports: Transport[] = [], enableOffline = true, paused = false) {
    const faro = await initializeFaro({
      app: { name: 'offline-replay-test' },
      url: collectorUrl,
      isolate: true,
      preventGlobalExposure: true,
      sessionTracking: { enabled: false },
      paused,
      enableTransports: { offline: enableOffline },
      transports: extraTransports,
    });
    offlineTransports = faro.transports.transports.filter(
      (transport): transport is OfflineTransport => transport instanceof OfflineTransport
    );
    return faro;
  }

  it('replays cached API signals through the configured collector after reconnecting', async () => {
    const faro = await initialize();
    faro.api.pushEvent('captured_offline', { source: 'test' });
    await settleReplay();
    const [offline] = offlineTransports;
    expect(offline).toBeDefined();
    expect(await offline?.getCachedCount()).toBe(1);
    collectorFetch.mockClear();
    mockConnectivity.isOnline = true;

    await offline?.forceReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    const [url, request] = collectorFetch.mock.calls[0];
    expect(url).toBe(collectorUrl);
    expect(JSON.parse(request.body).events).toEqual([
      expect.objectContaining({ name: 'captured_offline', attributes: { source: 'test' } }),
    ]);
    expect(await offline?.getCachedCount()).toBe(0);
  });

  it('retains a persisted payload after a rejected replay, then removes it after collector acceptance', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    await initialize();
    const [offline] = offlineTransports;
    mockConnectivity.isOnline = true;
    collectorFetch.mockResolvedValueOnce(response(500));

    await offline?.forceReplay();
    expect(await offline?.getCachedCount()).toBe(1);
    expect(collectorFetch).toHaveBeenCalledTimes(1);

    await offline?.forceReplay();
    expect(await offline?.getCachedCount()).toBe(0);
    expect(collectorFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(collectorFetch.mock.calls[1][1].body).meta.session.id).toBe('original-session');
  });

  it('automatically replays a persisted cache on online startup after transports are initialized', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    mockConnectivity.isOnline = true;

    await initialize();
    await settleReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
  });

  it('replays a supplied transport cache that was constructed before async SDK initialization', async () => {
    await AsyncStorage.setItem('custom-cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    mockConnectivity.isOnline = true;
    const offline = new OfflineTransport({ storageKeyPrefix: 'custom-cache' });
    await settleReplay();
    expect(collectorFetch).not.toHaveBeenCalled();

    await initialize([offline], false);
    await settleReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('migrates legacy cache identities once and preserves them across cache instances', async () => {
    const timestamp = Date.now();
    await AsyncStorage.setItem(
      'faro_offline_cache_data',
      JSON.stringify([
        { timestamp, items: [item] },
        { timestamp, items: [item], id: 'existing' },
        { timestamp, items: [item], id: 'existing' },
      ])
    );
    const cache = new AsyncStorageOfflineCache();
    const snapshot = await cache.readAll();
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map((entry) => entry.id)).toEqual(expect.arrayContaining(['existing']));
    expect(new Set(snapshot.map((entry) => entry.id)).size).toBe(3);
    expect(snapshot.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);

    const reloaded = await new AsyncStorageOfflineCache().readAll();
    expect(reloaded).toEqual(snapshot);
    const first = snapshot[0];
    expect(first).toBeDefined();
    if (first) {
      await cache.removeByTimestamps([timestamp], [first]);
    }
    expect(await cache.readAll()).toEqual(snapshot.slice(1));
  });

  it('wires an explicitly supplied offline transport without enabling the built-in one', async () => {
    const offline = new OfflineTransport({ storageKeyPrefix: 'custom-cache' });
    await initialize([offline], false);
    await offline.send([item]);
    mockConnectivity.isOnline = true;

    await offline.forceReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offline.getCachedCount()).toBe(0);
  });

  it('automatically replays the persisted cache on a connectivity notification', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    await initialize();
    mockConnectivity.isOnline = true;
    mockSubscribers.forEach((subscriber) => subscriber(true));
    await settleReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
  });

  it('retains the persisted cache on paused startup and can replay after unpausing', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    mockConnectivity.isOnline = true;
    const faro = await initialize([], true, true);
    await settleReplay();

    expect(collectorFetch).not.toHaveBeenCalled();
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);
    faro.unpause();
    await offlineTransports[0]?.forceReplay();
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
  });

  it('honors runtime pause for reconnect notifications and forceReplay', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    const faro = await initialize();
    faro.pause();
    mockConnectivity.isOnline = true;
    mockSubscribers.forEach((subscriber) => subscriber(true));
    await settleReplay();
    await offlineTransports[0]?.forceReplay();

    expect(collectorFetch).not.toHaveBeenCalled();
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);
    faro.unpause();
    await offlineTransports[0]?.forceReplay();
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
  });

  it('uses a replacement collector instead of a removed replay target', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    const faro = await initialize();
    const previous = faro.transports.transports.find((transport) => transport instanceof FetchTransport);
    expect(previous).toBeDefined();
    if (previous) {
      faro.transports.remove(previous);
    }
    mockConnectivity.isOnline = true;
    await offlineTransports[0]?.forceReplay();
    expect(collectorFetch).not.toHaveBeenCalled();
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);

    faro.transports.add(new FetchTransport({ url: 'https://replacement.example.com/collect' }));
    await offlineTransports[0]?.forceReplay();
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(collectorFetch.mock.calls[0][0]).toBe('https://replacement.example.com/collect');
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
  });

  it('does not replay through an offline transport removed from Faro', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    const faro = await initialize();
    const [offline] = offlineTransports;
    expect(offline).toBeDefined();
    if (offline) {
      faro.transports.remove(offline);
    }
    mockConnectivity.isOnline = true;
    mockSubscribers.forEach((subscriber) => subscriber(true));
    await settleReplay();
    await offline?.forceReplay();

    expect(collectorFetch).not.toHaveBeenCalled();
    expect(await offline?.getCachedCount()).toBe(1);
  });

  it('rechecks pause before sending to the next replay target', async () => {
    await AsyncStorage.setItem('faro_offline_cache_data', JSON.stringify([{ timestamp: Date.now(), items: [item] }]));
    const second = new FetchTransport({ url: 'https://second.example.com/collect' });
    const faro = await initialize([second]);
    mockConnectivity.isOnline = true;
    collectorFetch.mockImplementationOnce(async () => {
      faro.pause();
      return response(202);
    });
    await offlineTransports[0]?.forceReplay();

    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);
  });

  it.each([false, true])(
    'preserves a concurrent same-millisecond cache append (identical payload: %s)',
    async (identical) => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      await initialize();
      const [offline] = offlineTransports;
      await offline?.send([item]);
      mockConnectivity.isOnline = true;
      let accept: ((value: ReturnType<typeof response>) => void) | undefined;
      collectorFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          })
      );
      const replay = offline?.forceReplay();
      await settleReplay();
      expect(collectorFetch).toHaveBeenCalledTimes(1);
      mockConnectivity.isOnline = false;
      const nextItem = identical ? item : { ...item, payload: { ...item.payload, message: 'cached during delivery' } };
      await offline?.send([nextItem]);
      expect(await offline?.getCachedCount()).toBe(2);

      expect(accept).toBeDefined();
      accept?.(response(202));
      await replay;

      expect(await offline?.getCachedCount()).toBe(1);
      const data = await AsyncStorage.getItem('faro_offline_cache_data');
      expect(data && JSON.parse(data)[0].items).toEqual([nextItem]);
    }
  );

  it('does not acknowledge a new identical entry after the in-flight entry is evicted', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const offline = new OfflineTransport({ storageKeyPrefix: 'one-entry-cache', maxCacheSize: 1 });
    await initialize([offline], false);
    await offline.send([item]);
    mockConnectivity.isOnline = true;
    let accept: ((value: ReturnType<typeof response>) => void) | undefined;
    collectorFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const replay = offline.forceReplay();
    await settleReplay();
    mockConnectivity.isOnline = false;
    await offline.send([item]);
    expect(await offline.getCachedCount()).toBe(1);

    expect(accept).toBeDefined();
    accept?.(response(202));
    await replay;

    expect(await offline.getCachedCount()).toBe(1);
  });

  it('does not replay into another offline cache', async () => {
    const extra = new OfflineTransport({ storageKeyPrefix: 'extra-cache' });
    const extraSend = jest.spyOn(extra, 'send');
    const faro = await initialize([extra]);
    const [builtIn] = offlineTransports;
    const builtInSend = builtIn && jest.spyOn(builtIn, 'send');
    await builtIn?.send([item]);
    mockConnectivity.isOnline = true;

    await builtIn?.forceReplay();

    expect(extraSend).not.toHaveBeenCalled();
    expect(builtInSend).toHaveBeenCalledTimes(1);
    expect(faro.transports.transports.some((transport) => transport instanceof FetchTransport)).toBe(true);
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await extra.getCachedCount()).toBe(0);
  });
  it('retries reconnect replay after the live Fetch circuit breaker expires', async () => {
    jest.useFakeTimers();
    const faro = await initialize();
    const fetchTransport = faro.transports.transports.find((transport) => transport instanceof FetchTransport);
    collectorFetch.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 3; i++) await fetchTransport?.send([item]);
    await offlineTransports[0]?.send([item]);
    collectorFetch.mockClear().mockResolvedValue(response(202));
    mockConnectivity.isOnline = true;
    mockSubscribers.forEach((subscriber) => subscriber(true));
    await jest.advanceTimersByTimeAsync(0);
    expect(collectorFetch).not.toHaveBeenCalled();
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(31000);
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('backs off temporary failures and stops retrying after acceptance', async () => {
    jest.useFakeTimers();
    await initialize();
    await offlineTransports[0]?.send([item]);
    mockConnectivity.isOnline = true;
    collectorFetch.mockResolvedValue(response(503));
    await offlineTransports[0]?.forceReplay();
    await jest.advanceTimersByTimeAsync(999);
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(collectorFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1999);
    expect(collectorFetch).toHaveBeenCalledTimes(2);
    collectorFetch.mockResolvedValue(response(202));
    await jest.advanceTimersByTimeAsync(1);
    expect(collectorFetch).toHaveBeenCalledTimes(3);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['pause', 'remove', 'offline', 'dispose'])('stops scheduled retry on %s', async (action) => {
    jest.useFakeTimers();
    const faro = await initialize();
    const offline = offlineTransports[0];
    await offline?.send([item]);
    mockConnectivity.isOnline = true;
    collectorFetch.mockResolvedValue(response(503));
    await offline?.forceReplay();
    if (action === 'pause') faro.pause();
    if (action === 'remove' && offline) faro.transports.remove(offline);
    if (action === 'offline') mockConnectivity.isOnline = false;
    if (action === 'dispose') offline?.dispose();
    await jest.advanceTimersByTimeAsync(60000);
    await offline?.forceReplay();
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    expect(await offline?.getCachedCount()).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['none', 'pause', 'remove'])(
    'delivers nonbatched items individually with %s between sends',
    async (action) => {
      class ItemTransport extends BaseTransport {
        readonly name = 'item-transport';
        readonly version = VERSION;
        send = jest.fn(async (entry: TransportItem) => {
          expect(Array.isArray(entry)).toBe(false);
          expect(entry.payload).toBeDefined();
          if (action === 'pause') faro.pause();
          if (action === 'remove') faro.transports.remove(custom);
        });
      }
      const custom = new ItemTransport();
      const faro = await initialize([custom]);
      await offlineTransports[0]?.send([item, { ...item, payload: { ...item.payload, message: 'second' } }]);
      mockConnectivity.isOnline = true;
      await offlineTransports[0]?.forceReplay();
      expect(custom.send).toHaveBeenCalledTimes(action === 'none' ? 2 : 1);
      expect(custom.send.mock.calls.every(([entry]) => !Array.isArray(entry))).toBe(true);
      expect(custom.send.mock.calls[0]?.[0]).toEqual(item);
      expect(await offlineTransports[0]?.getCachedCount()).toBe(action === 'none' ? 0 : 1);
    }
  );

  it('resumes failed replay when the app becomes active and removes its listener on dispose', async () => {
    jest.useFakeTimers();
    const remove = jest.fn();
    const listen = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    await initialize();
    const offline = offlineTransports[0];
    await offline?.send([item]);
    mockConnectivity.isOnline = true;
    collectorFetch.mockResolvedValue(response(503));
    await offline?.forceReplay();
    expect(jest.getTimerCount()).toBe(1);
    const handler = listen.mock.calls[0]?.[1];
    Object.defineProperty(AppState, 'currentState', { value: 'background' });
    handler?.('background');
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(collectorFetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(AppState, 'currentState', { value: 'active' });
    collectorFetch.mockResolvedValue(response(202));
    handler?.('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(collectorFetch).toHaveBeenCalledTimes(2);
    expect(await offline?.getCachedCount()).toBe(0);
    offline?.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
    handler?.('active');
    await jest.advanceTimersByTimeAsync(60000);
    expect(collectorFetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 429])('retains HTTP %s and only retries temporary rejection', async (status) => {
    jest.useFakeTimers();
    await initialize();
    await offlineTransports[0]?.send([item]);
    mockConnectivity.isOnline = true;
    collectorFetch.mockResolvedValueOnce(response(status));
    await offlineTransports[0]?.forceReplay();
    expect(await offlineTransports[0]?.getCachedCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(7000);
    expect(collectorFetch).toHaveBeenCalledTimes(status === 429 ? 2 : 1);
    expect(await offlineTransports[0]?.getCachedCount()).toBe(status === 429 ? 0 : 1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([false, true])('preserves duplicate initialization return with offline %s', async (offline) => {
    const config = {
      app: { name: 'duplicate-init' },
      url: collectorUrl,
      sessionTracking: { enabled: false },
      enableTransports: { offline },
    };
    if (!('_faroInternal' in globalThis)) {
      const first = await initializeFaro(config);
      offlineTransports = first.transports.transports.filter(
        (transport): transport is OfflineTransport => transport instanceof OfflineTransport
      );
    }
    await expect(initializeFaro(config)).resolves.toBeUndefined();
  });
});
