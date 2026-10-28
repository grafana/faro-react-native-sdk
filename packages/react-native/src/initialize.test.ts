import { type Config, getTransportBody, type TransportItem, VERSION } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import packageJson from '../package.json';

import { initializeFaro } from './initialize';
import { SessionInstrumentation } from './instrumentations/session';
import * as sessionAttributes from './instrumentations/session/sessionAttributes';
import * as appBuildIdentity from './metas/appBuildIdentity';

describe('initializeFaro', () => {
  const preambleKey = '__faroBundleId_test';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    delete (global as any).faro;
    delete (globalThis as Record<string, unknown>)[preambleKey];
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[preambleKey];
  });

  it.each([
    {
      source: 'explicit',
      explicit: 'explicit-bundle',
      metro: 'metro-bundle',
      native: 'native-bundle',
      expected: 'explicit-bundle',
    },
    { source: 'Metro', metro: 'metro-bundle', native: 'native-bundle', expected: 'metro-bundle' },
    { source: 'native', native: 'native-bundle', expected: 'native-bundle' },
    { source: 'unavailable', expected: undefined },
    { source: 'native without preloaded app', native: 'native-bundle', expected: 'native-bundle', preloaded: false },
    { source: 'unavailable without preloaded app', expected: undefined, preloaded: false },
  ])(
    'preserves configured app metadata in emitted telemetry with $source bundle identity',
    async ({ explicit, metro, native, expected, preloaded = true }) => {
      const mobileSpy = jest.spyOn(sessionAttributes, 'loadMobileMetaForInit').mockResolvedValue({
        sessionAttributes: sessionAttributes.minimalSessionDeviceAttributes(),
        meta: preloaded ? { app: { installationId: 'preloaded-installation' } } : {},
      });
      const bundleSpy = jest.spyOn(appBuildIdentity, 'loadAppSymbolsBundleIdForInit').mockResolvedValue(native);
      if (metro) {
        (globalThis as Record<string, unknown>)[preambleKey] = metro;
      }
      const app = {
        name: 'test',
        version: '1.0.42',
        environment: 'production',
        namespace: 'test-namespace',
        release: 'release-42',
        installationId: 'configured-installation',
        ...(explicit && { bundleId: explicit }),
      };
      const transport = new MockTransport();
      try {
        const faro = await initializeFaro(
          mockConfig({
            url: 'http://localhost:12345/collect',
            app,
            transports: [transport],
            sessionTracking: { enabled: true, persistent: false },
          })
        );
        transport.items = [];
        faro.api.pushEvent('app_metadata_regression');
        expect(transport.items).toHaveLength(1);
        const expectedApp = { ...app, ...(expected && { bundleId: expected }) };
        expect(faro.metas.value.app).toEqual(expectedApp);
        expect(JSON.parse(JSON.stringify(getTransportBody(transport.items))).meta.app).toEqual(expectedApp);
      } finally {
        mobileSpy.mockRestore();
        bundleSpy.mockRestore();
      }
    }
  );

  it('should initialize Faro', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(faro).toBeDefined();
    expect(faro.api).toBeDefined();
    expect(faro.metas).toBeDefined();
  });

  it('should set session on init for volatile session tracking', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(faro).toBeDefined();
    expect(faro.metas.value.session?.id).toBeDefined();
  });

  it('should attach session to telemetry events after init', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    transport.items = [];
    faro.api.pushEvent('test_event', { data: 'test' });

    expect(transport.items).toHaveLength(1);
    expect(transport.items[0].meta.session).toBeDefined();
    expect(transport.items[0].meta.session?.id).toBeDefined();
  });

  it('should reject when url is missing', async () => {
    await expect(
      initializeFaro(
        mockConfig({
          // @ts-expect-error - testing missing url
          url: undefined,
          transports: [],
        })
      )
    ).rejects.toThrow('url is required');
  });

  it('should await mobile meta then merge structured meta and preloaded session attributes', async () => {
    const spy = jest.spyOn(sessionAttributes, 'loadMobileMetaForInit').mockResolvedValue({
      sessionAttributes: {
        react_native_version: '0.0.1',
        device_os: 'iOS',
        device_os_version: '17.0',
        device_os_detail: 'iOS 17.0',
        device_manufacturer: 'apple',
        device_model: 'test-model-identifier',
        device_model_name: 'Test Phone',
        device_brand: 'Apple',
        device_is_physical: 'true',
        device_id: 'preloaded-device-id',
        device_memory_total: '100',
        device_memory_used: '50',
      },
      meta: {
        app: {
          installationId: 'preloaded-installation-id',
        },
        device: {
          brand: 'Apple',
          is_physical: true,
          manufacturer: 'apple',
          model_identifier: 'test-model-identifier',
          model_name: 'Test Phone',
        },
        os: {
          detail: 'iOS 17.0',
          name: 'iOS',
          version: '17.0',
        },
      },
    });

    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(spy).toHaveBeenCalled();
    expect(faro.metas.value.sdk?.name).toBe('faro-react-native');
    expect(faro.metas.value.sdk?.version).toBe(packageJson.version);
    expect(faro.metas.value.sdk?.integrations).toEqual([{ name: '@grafana/faro-core', version: VERSION }]);
    expect(faro.metas.value.app).toMatchObject({
      name: 'test',
      version: '1.0.0',
      installationId: 'preloaded-installation-id',
    });
    expect(faro.metas.value.device?.model_identifier).toBe('test-model-identifier');
    expect(faro.metas.value.os?.name).toBe('iOS');
    expect(faro.metas.value.session?.attributes?.['react_native_version']).toBe('0.0.1');
    expect(faro.metas.value.session?.attributes?.['device_id']).toBe('preloaded-device-id');

    spy.mockRestore();
  });

  it('should set meta.app.bundleId from Faro Metro preamble global (__faroBundleId_<app.name>)', async () => {
    (globalThis as Record<string, unknown>)[preambleKey] = 'release-bundle-from-metro';

    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(faro.metas.value.app?.bundleId).toBe('release-bundle-from-metro');
  });

  it('should keep config.app.bundleId when set explicitly (do not override with symbols id)', async () => {
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        app: { bundleId: 'user-env-bundle-id' },
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(faro.metas.value.app?.bundleId).toBe('user-env-bundle-id');
  });

  it('should set meta.app.bundleId (encoded build identity) from DeviceInfo when no Metro id', async () => {
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(faro.metas.value.app?.bundleId).toBe('com.example.myapp@42@1.0.0');
  });

  describe('batching', () => {
    async function initWithBatching(batching?: Config['batching'], overrides: Partial<Config> = {}) {
      const transport = new MockTransport();
      const send = jest.spyOn(transport, 'send');
      const faro = await initializeFaro(
        mockConfig({
          url: 'http://localhost:12345/collect',
          transports: [transport],
          sessionTracking: { enabled: true, persistent: false },
          ...(batching ? { batching } : {}),
          ...overrides,
        })
      );
      jest.runOnlyPendingTimers();
      send.mockClear();
      transport.items = [];
      return { faro, transport, send };
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sends each item immediately when batching is not configured', async () => {
      const { faro, send } = await initWithBatching();

      faro.api.pushEvent('one');
      faro.api.pushEvent('two');

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('flushes queued items when sendTimeout elapses', async () => {
      const { faro, transport, send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 200 });

      faro.api.pushEvent('one');
      faro.api.pushEvent('two');
      faro.api.pushEvent('three');
      jest.advanceTimersByTime(1_999);
      expect(send).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(transport.items).toHaveLength(3);
    });

    it('flushes queued items when itemLimit is reached', async () => {
      const { faro, transport, send } = await initWithBatching({ enabled: true, sendTimeout: 10_000, itemLimit: 2 });

      faro.api.pushEvent('one');
      expect(send).not.toHaveBeenCalled();

      faro.api.pushEvent('two');
      expect(send).toHaveBeenCalledTimes(1);
      expect(transport.items).toHaveLength(2);
    });

    it('sends the same item count in every request when batching is disabled explicitly', async () => {
      const { faro, send } = await initWithBatching({ enabled: false, sendTimeout: 2_000, itemLimit: 200 });

      faro.api.pushEvent('one');
      faro.api.pushEvent('two');

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.map(([items]) => (items as unknown[]).length)).toEqual([1, 1]);
    });

    it('sends nothing on timer ticks with an empty queue', async () => {
      const { send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 200 });

      jest.advanceTimersByTime(10_000);

      expect(send).not.toHaveBeenCalled();
    });

    it('keeps flushing on every sendTimeout tick', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 200 });

      faro.api.pushEvent('one');
      jest.advanceTimersByTime(2_000);
      faro.api.pushEvent('two');
      faro.api.pushEvent('three');
      jest.advanceTimersByTime(2_000);

      expect(send.mock.calls.map(([items]) => (items as unknown[]).length)).toEqual([1, 2]);
    });

    it('sends one request per full batch and leaves the remainder for the timer', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 10_000, itemLimit: 2 });

      for (let i = 0; i < 5; i++) {
        faro.api.pushEvent(`event-${i}`);
      }
      expect(send.mock.calls.map(([items]) => (items as unknown[]).length)).toEqual([2, 2]);

      jest.advanceTimersByTime(10_000);
      expect(send.mock.calls.map(([items]) => (items as unknown[]).length)).toEqual([2, 2, 1]);
    });

    it('does not restart the timer after an itemLimit flush', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 2 });

      jest.advanceTimersByTime(1_500);
      faro.api.pushEvent('one');
      faro.api.pushEvent('two');
      expect(send).toHaveBeenCalledTimes(1);

      faro.api.pushEvent('three');
      jest.advanceTimersByTime(500);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toHaveLength(1);
    });

    it('sends every item immediately when itemLimit is 1', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 10_000, itemLimit: 1 });

      faro.api.pushEvent('one');
      faro.api.pushEvent('two');

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('only flushes on itemLimit when sendTimeout is 0', async () => {
      // No session tracking: a fresh session would queue `session_start`, and with no timer it is never flushed.
      const { faro, send } = await initWithBatching(
        { enabled: true, sendTimeout: 0, itemLimit: 3 },
        { sessionTracking: { enabled: false } }
      );

      faro.api.pushEvent('one');
      faro.api.pushEvent('two');
      jest.advanceTimersByTime(60_000);
      expect(send).not.toHaveBeenCalled();

      faro.api.pushEvent('three');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toHaveLength(3);
    });

    it('splits one flush into separate requests when item metadata differs', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 200 });

      faro.api.pushEvent('anonymous');
      faro.api.setUser({ id: 'user-1' });
      faro.api.pushEvent('signed-in');
      jest.advanceTimersByTime(2_000);

      expect(send).toHaveBeenCalledTimes(2);
      const sentUserIds = send.mock.calls.map(([items]) => (items as TransportItem[])[0]?.meta.user?.id);
      expect(sentUserIds).toEqual([undefined, 'user-1']);
    });

    it('applies beforeSend once per item and drops filtered items from the batch', async () => {
      const beforeSend = jest.fn((item: TransportItem) =>
        (item.payload as { name?: string }).name === 'drop' ? null : item
      );
      const { faro, transport, send } = await initWithBatching(
        { enabled: true, sendTimeout: 2_000, itemLimit: 200 },
        { beforeSend }
      );
      beforeSend.mockClear();

      faro.api.pushEvent('keep');
      faro.api.pushEvent('drop');
      jest.advanceTimersByTime(2_000);

      expect(beforeSend).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(1);
      expect(transport.items.map((item) => (item.payload as { name: string }).name)).toEqual(['keep']);
    });

    it('sends nothing when every queued item is dropped by beforeSend', async () => {
      const { faro, send } = await initWithBatching(
        { enabled: true, sendTimeout: 2_000, itemLimit: 200 },
        { beforeSend: () => null }
      );

      faro.api.pushEvent('drop');
      jest.advanceTimersByTime(2_000);

      expect(send).not.toHaveBeenCalled();
    });

    it('still sends to unbatched transports immediately', async () => {
      const unbatched = new MockTransport();
      jest.spyOn(unbatched, 'isBatched').mockReturnValue(false);
      const unbatchedSend = jest.spyOn(unbatched, 'send');
      const batched = new MockTransport();
      const batchedSend = jest.spyOn(batched, 'send');
      const faro = await initializeFaro(
        mockConfig({
          url: 'http://localhost:12345/collect',
          transports: [batched, unbatched],
          sessionTracking: { enabled: true, persistent: false },
          batching: { enabled: true, sendTimeout: 2_000, itemLimit: 200 },
        })
      );
      jest.runOnlyPendingTimers();
      unbatchedSend.mockClear();
      batchedSend.mockClear();

      faro.api.pushEvent('one');

      expect(unbatchedSend).toHaveBeenCalledTimes(1);
      expect(batchedSend).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2_000);
      expect(batchedSend).toHaveBeenCalledTimes(1);
    });

    describe('request bodies when beforeSend changes metadata', () => {
      const originalFetch = global.fetch;
      const fetchMock = jest.fn((_url: string, _init: { body: string }) =>
        Promise.resolve({ status: 202, text: () => Promise.resolve(''), headers: { get: () => null } })
      );

      beforeEach(() => {
        fetchMock.mockClear();
        (global as any).fetch = fetchMock;
      });

      afterEach(() => {
        (global as any).fetch = originalFetch;
      });

      // Removes the user from exceptions only, so a flush holds items with different final metadata.
      const removeUserFromExceptions = (item: TransportItem) =>
        item.type === 'exception' ? { ...item, meta: { ...item.meta, user: undefined } } : item;

      async function initWithFetch(beforeSend: Config['beforeSend']) {
        const faro = await initializeFaro({
          url: 'http://localhost:12345/collect',
          app: { name: 'request-body-test', version: '1.0.0' },
          batching: { enabled: true, sendTimeout: 2_000, itemLimit: 200 },
          isolate: true,
          beforeSend,
          // Without session tracking, FetchTransport sends without waiting for a session.
          sessionTracking: { enabled: false },
        });
        faro.api.setUser({ id: 'user-1' });
        await jest.advanceTimersByTimeAsync(2_000);
        fetchMock.mockClear();
        return faro;
      }

      // Faro instances from earlier tests in this file can still send through the
      // fetch mock, and HTTP instrumentation reports those requests.
      function sentBodies() {
        return fetchMock.mock.calls
          .map(([, init]) => JSON.parse(init.body))
          .filter((body) => body.meta?.app?.name === 'request-body-test')
          .filter((body) => !body.events?.every((event: { name: string }) => event.name === 'faro.tracing.fetch'));
      }

      it.each(['event first', 'exception first'])('keeps the final metadata of each item (%s)', async (order) => {
        const faro = await initWithFetch(removeUserFromExceptions);

        if (order === 'event first') {
          faro.api.pushEvent('ordinary');
          faro.api.pushError(new Error('boom'));
        } else {
          faro.api.pushError(new Error('boom'));
          faro.api.pushEvent('ordinary');
        }
        await jest.advanceTimersByTimeAsync(2_000);

        const bodies = sentBodies();
        expect(bodies).toHaveLength(2);
        const eventBody = bodies.find((body) => body.events);
        const exceptionBody = bodies.find((body) => body.exceptions);
        expect(eventBody.meta.user).toEqual(expect.objectContaining({ id: 'user-1' }));
        expect(eventBody.exceptions).toBeUndefined();
        expect(exceptionBody.meta.user).toBeUndefined();
        expect(exceptionBody.events).toBeUndefined();
      });

      it('sends one request when beforeSend leaves the metadata alone', async () => {
        const faro = await initWithFetch((item) => item);

        faro.api.pushEvent('ordinary');
        faro.api.pushError(new Error('boom'));
        await jest.advanceTimersByTimeAsync(2_000);

        const bodies = sentBodies();
        expect(bodies).toHaveLength(1);
        expect(bodies[0].events).toHaveLength(1);
        expect(bodies[0].exceptions).toHaveLength(1);
      });

      it('sends nothing when beforeSend drops every item', async () => {
        const faro = await initWithFetch(() => null);

        faro.api.pushEvent('ordinary');
        faro.api.pushError(new Error('boom'));
        await jest.advanceTimersByTimeAsync(2_000);

        expect(sentBodies()).toHaveLength(0);
      });
    });

    it('stops flushing while paused and resumes on unpause', async () => {
      const { faro, send } = await initWithBatching({ enabled: true, sendTimeout: 2_000, itemLimit: 200 });

      faro.api.pushEvent('before-pause');
      faro.pause();
      faro.api.pushEvent('while-paused');
      jest.advanceTimersByTime(10_000);
      expect(send).not.toHaveBeenCalled();

      faro.unpause();
      faro.api.pushEvent('after-unpause');
      jest.advanceTimersByTime(2_000);

      expect(send).toHaveBeenCalledTimes(1);
      const names = (send.mock.calls[0]?.[0] as TransportItem[]).map((item) => (item.payload as { name: string }).name);
      expect(names).toEqual(['before-pause', 'after-unpause']);
    });
  });
});
