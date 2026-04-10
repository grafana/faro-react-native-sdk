import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { initializeFaro, initializeFaroAsync } from './initialize';
import { SessionInstrumentation } from './instrumentations/session';

describe('initializeFaro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    // Clear global faro if it exists
    delete (global as any).faro;
  });

  it('should initialize Faro synchronously', () => {
    const transport = new MockTransport();
    const faro = initializeFaro(
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

  it('should return immediately without waiting for session', () => {
    const transport = new MockTransport();
    const faro = initializeFaro(
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

    // Session might not be available immediately
    expect(faro).toBeDefined();
  });

  it('should throw error when url is missing', () => {
    expect(() => {
      initializeFaro(
        mockConfig({
          // @ts-expect-error - testing missing url
          url: undefined,
          transports: [],
        })
      );
    }).toThrow('url is required');
  });
});

describe('initializeFaroAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    // Clear global faro if it exists
    delete (global as any).faro;
  });

  it('should initialize Faro and wait for session', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaroAsync(
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
    // Session should be initialized by now
    expect(faro.metas.value.session).toBeDefined();
  });

  it('should return with session metadata available', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaroAsync(
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

    // Session should be set in metas
    const session = faro.metas.value.session;
    expect(session).toBeDefined();
    expect(session?.id).toBeDefined();
    expect(typeof session?.id).toBe('string');
  });

  it('should complete within timeout even if session is disabled', async () => {
    const transport = new MockTransport();
    const startTime = Date.now();

    const faro = await initializeFaroAsync(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        sessionTracking: {
          enabled: false,
        },
      })
    );

    const elapsed = Date.now() - startTime;

    expect(faro).toBeDefined();
    // Should timeout quickly (within 1000ms + some buffer)
    expect(elapsed).toBeLessThan(1500);
  });

  it('should attach session to early telemetry events', async () => {
    const transport = new MockTransport();
    const faro = await initializeFaroAsync(
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

    // Clear any initialization events
    transport.items = [];

    // Push an event immediately after initialization
    faro.api.pushEvent('test_event', { data: 'test' });

    // Event should have session metadata
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0].meta.session).toBeDefined();
    expect(transport.items[0].meta.session?.id).toBeDefined();
  });

  it('should throw error when url is missing', async () => {
    await expect(
      initializeFaroAsync(
        mockConfig({
          // @ts-expect-error - testing missing url
          url: undefined,
          transports: [],
        })
      )
    ).rejects.toThrow('url is required');
  });
});
