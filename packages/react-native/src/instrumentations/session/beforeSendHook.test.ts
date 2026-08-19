import { TransportItemType } from '@grafana/faro-core';
import type { TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingRate } from '../../config/sampling';
import { initializeFaro } from '../../initialize';
import { EVENT_NAVIGATION } from '../../navigation/utils';
import { EVENT_APP_STATE_CHANGED } from '../appState';

import { SessionInstrumentation } from './index';
import type { FaroUserSession } from './sessionManager';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

function testEventItems(transport: MockTransport) {
  return transport.items.filter((i) => i.type === 'event' && i.payload.name === 'test_event');
}

function getVolatileSession(): FaroUserSession {
  const session = VolatileSessionsManager.fetchUserSession();
  if (session == null) {
    throw new Error('Expected an active volatile session.');
  }
  return session;
}

describe('SessionInstrumentation beforeSend hook', () => {
  let transport: MockTransport;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    jest.clearAllMocks();
    VolatileSessionsManager.removeUserSession();
  });

  afterEach(() => {
    jest.useRealTimers();
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
          sampling: new SamplingRate(0),
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

    // The internal sampling decision must survive an overrides-only update.
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

  it('does not refresh inactivity for passive telemetry', async () => {
    transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const session = getVolatileSession();
    const previousActivity = Date.now() - 5 * 60 * 1000;
    VolatileSessionsManager.storeUserSession({ ...session, lastActivity: previousActivity });

    faro.api.pushEvent('poll_complete');

    expect(VolatileSessionsManager.fetchUserSession()).toMatchObject({
      sessionId: session.sessionId,
      lastActivity: previousActivity,
    });
  });

  it('rotates passive telemetry at the exact inactivity boundary before sending it', async () => {
    transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const previousSession = getVolatileSession();
    VolatileSessionsManager.storeUserSession({
      ...previousSession,
      lastActivity: Date.now() - 15 * 60 * 1000,
    });

    faro.api.pushEvent('poll_complete');

    const nextSession = getVolatileSession();
    const sentEvent = transport.items.find(
      (item) => item.type === TransportItemType.EVENT && item.payload.name === 'poll_complete'
    );
    expect(nextSession.sessionId).not.toBe(previousSession.sessionId);
    expect(nextSession.sessionMeta?.attributes?.['previousSession']).toBe(previousSession.sessionId);
    expect(sentEvent?.meta.session?.id).toBe(nextSession.sessionId);
  });

  it('refreshes inactivity for navigation and tracked user actions', async () => {
    transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const session = getVolatileSession();

    VolatileSessionsManager.storeUserSession({ ...session, lastActivity: Date.now() - 10 * 60 * 1000 });
    faro.api.pushEvent(EVENT_NAVIGATION, { screen: 'checkout' });
    expect(VolatileSessionsManager.fetchUserSession()?.lastActivity).toBe(Date.now());

    jest.advanceTimersByTime(1000);
    VolatileSessionsManager.storeUserSession({ ...session, lastActivity: Date.now() - 10 * 60 * 1000 });
    const action = faro.api.startUserAction('checkout');
    faro.api.pushEvent('background_work_complete');
    action?.end();
    expect(VolatileSessionsManager.fetchUserSession()?.lastActivity).toBe(Date.now());
  });

  it('rotates a foreground return at the exact boundary before sending it', async () => {
    transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const previousSession = getVolatileSession();
    VolatileSessionsManager.storeUserSession({
      ...previousSession,
      lastActivity: Date.now() - 15 * 60 * 1000,
    });

    faro.api.pushEvent(EVENT_APP_STATE_CHANGED, { fromState: 'background', toState: 'active' });

    const nextSession = getVolatileSession();
    const lifecycleEvent = transport.items.find(
      (item) => item.type === TransportItemType.EVENT && item.payload.name === EVENT_APP_STATE_CHANGED
    );
    expect(nextSession.sessionId).not.toBe(previousSession.sessionId);
    expect(lifecycleEvent?.meta.session?.id).toBe(nextSession.sessionId);
  });

  it('preserves the crash-time session on recovered crashes', async () => {
    transport = new MockTransport();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const currentSession = getVolatileSession();
    const recoveredCrash: TransportItem = {
      type: TransportItemType.EXCEPTION,
      meta: {
        session: {
          id: 'crashed-session',
          attributes: { isSampled: 'true' },
        },
      },
      payload: {
        type: 'crash',
        value: 'native crash',
        fatal: true,
        timestamp: new Date().toISOString(),
      },
    };

    const result = faro.transports
      .getBeforeSendHooks()
      .reduce<TransportItem | null>((item, hook) => (item == null ? null : hook(item)), recoveredCrash);

    expect(result?.meta.session).toStrictEqual({ id: 'crashed-session' });
    expect(VolatileSessionsManager.fetchUserSession()).toStrictEqual(currentSession);
  });
});
