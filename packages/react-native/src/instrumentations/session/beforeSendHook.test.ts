import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingRate } from '../../config/sampling';
import { initializeFaro } from '../../initialize';

import { SessionInstrumentation } from './index';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

function testEventItems(transport: MockTransport) {
  return transport.items.filter((i) => i.type === 'event' && i.payload.name === 'test_event');
}

describe('SessionInstrumentation beforeSend hook', () => {
  let transport: MockTransport;

  beforeEach(() => {
    jest.clearAllMocks();
    VolatileSessionsManager.removeUserSession();
  });

  it('should pass through items when session is sampled (isSampled="true")', async () => {
    transport = new MockTransport();

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

    // Manually set session with isSampled='true'
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { isSampled: 'true' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the item (after removing isSampled attribute); ignore session_start from init / setSession
    const testEvents = testEventItems(transport);
    expect(testEvents).toHaveLength(1);
    expect(testEvents[0].meta.session?.id).toBe('test-session-id');
    expect(testEvents[0].meta.session?.attributes?.['isSampled']).toBeUndefined();
  });

  it('should drop items when session is not sampled (isSampled="false")', async () => {
    transport = new MockTransport();

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

    // Manually set session with isSampled='false'
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { isSampled: 'false' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should NOT send the test event (session_start may still be emitted before setSession)
    expect(testEventItems(transport)).toHaveLength(0);
  });

  it('keeps dropping items after an overrides-only session update', async () => {
    transport = new MockTransport();

    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
          sampling: new SamplingRate(0),
        },
      })
    );

    faro.api.setSession({
      id: faro.api.getSession()?.id,
      overrides: { serviceName: 'override-service' },
    });

    // This event is sent before the async session-meta listener can restore
    // internal attributes, so the manager's sampling decision must still win.
    faro.api.pushEvent('test_event', { data: 'test' });

    expect(testEventItems(transport)).toHaveLength(0);
  });

  it('should pass through items when no isSampled attribute exists', async () => {
    transport = new MockTransport();

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

    // Manually set session WITHOUT isSampled attribute
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { customAttr: 'value' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the item unchanged
    const testEvents = testEventItems(transport);
    expect(testEvents).toHaveLength(1);
    expect(testEvents[0].meta.session?.id).toBe('test-session-id');
    expect(testEvents[0].meta.session?.attributes?.['customAttr']).toBe('value');
  });

  it('should pass through items when no session exists', async () => {
    transport = new MockTransport();

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

    // Push an event without setting any session
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the test event (session is set at init)
    expect(testEventItems(transport)).toHaveLength(1);
  });
});
