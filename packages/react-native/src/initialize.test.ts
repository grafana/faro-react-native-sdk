import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { initializeFaro } from './initialize';
import { SessionInstrumentation } from './instrumentations/session';
import * as sessionAttributes from './instrumentations/session/sessionAttributes';

describe('initializeFaro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    delete (global as any).faro;
  });

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

  it('should await device attributes then merge preloaded session attributes', async () => {
    const spy = jest.spyOn(sessionAttributes, 'loadSessionDeviceAttributesForInit').mockResolvedValue({
      faro_sdk_version: '9.9.9',
      react_native_version: '0.0.1',
      device_os: 'iOS',
      device_os_version: '17.0',
      device_os_detail: 'iOS 17.0',
      device_manufacturer: 'apple',
      device_model: 'test-model',
      device_model_name: 'Test Phone',
      device_brand: 'Apple',
      device_is_physical: 'true',
      device_id: 'preloaded-device-id',
      device_type: 'mobile',
      device_memory_total: '100',
      device_memory_used: '50',
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
    expect(faro.metas.value.session?.attributes?.['faro_sdk_version']).toBe('9.9.9');
    expect(faro.metas.value.session?.attributes?.['device_id']).toBe('preloaded-device-id');

    spy.mockRestore();
  });
});
