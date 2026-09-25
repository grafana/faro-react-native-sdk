import { getTransportBody, VERSION } from '@grafana/faro-core';
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
        device_model: 'Test Phone',
        device_model_name: "Test's iPhone",
        device_brand: 'Apple',
        device_is_physical: 'true',
        device_id: 'preloaded-device-id',
        device_type: 'mobile',
        device_memory_total: '100',
        device_memory_used: '50',
      },
      meta: {
        app: {
          installationId: 'preloaded-installation-id',
        },
        device: {
          brand: 'iPhone',
          is_physical: true,
          manufacturer: 'apple',
          model_identifier: 'test-model-identifier',
          model_name: 'Test Phone',
          type: 'mobile',
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
    expect(faro.metas.value.sdk?.version).toBe(VERSION);
    expect(faro.metas.value.sdk?.integrations).toEqual([{ name: packageJson.name, version: packageJson.version }]);
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
});
