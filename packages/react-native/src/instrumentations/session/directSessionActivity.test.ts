import { EVENT_SESSION_START, initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { notifySessionActivity, registerDirectSessionActivityHandler } from './directSessionActivity';
import { SessionInstrumentation } from './index';
import type { FaroUserSession } from './sessionManager';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

function getVolatileSession(): FaroUserSession {
  const session = VolatileSessionsManager.fetchUserSession();
  if (session == null) {
    throw new Error('Expected an active volatile session.');
  }
  return session;
}

describe('direct session activity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    jest.clearAllMocks();
    VolatileSessionsManager.removeUserSession();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing before session tracking initializes', () => {
    expect(() => notifySessionActivity()).not.toThrow();
  });

  it('does not let an activity handler failure escape into the app', () => {
    const unregister = registerDirectSessionActivityHandler(() => {
      throw new Error('activity failed');
    });

    expect(() => notifySessionActivity()).not.toThrow();
    unregister();
  });

  it('refreshes an active session without emitting telemetry', async () => {
    const transport = new MockTransport();
    const instrumentation = new SessionInstrumentation();
    await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [instrumentation],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const session = getVolatileSession();
    VolatileSessionsManager.storeUserSession({
      ...session,
      lastActivity: Date.now() - 10 * 60 * 1000,
    });
    transport.items = [];

    notifySessionActivity();

    expect(VolatileSessionsManager.fetchUserSession()).toMatchObject({
      sessionId: session.sessionId,
      lastActivity: Date.now(),
    });
    expect(transport.items).toHaveLength(0);
    instrumentation.unpatch();
  });

  it('rotates at the inactivity boundary before later telemetry is attributed', async () => {
    const transport = new MockTransport();
    const instrumentation = new SessionInstrumentation();
    const faro = await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [transport],
        instrumentations: [instrumentation],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const previousSession = getVolatileSession();
    VolatileSessionsManager.storeUserSession({
      ...previousSession,
      lastActivity: Date.now() - 15 * 60 * 1000,
    });
    transport.items = [];

    notifySessionActivity();
    faro.api.pushEvent('pressed_button');

    const nextSession = getVolatileSession();
    const sessionStartEvents = transport.items.filter(
      (item) => item.type === 'event' && item.payload.name === EVENT_SESSION_START
    );
    const pressedButton = transport.items.find(
      (item) => item.type === 'event' && item.payload.name === 'pressed_button'
    );
    expect(nextSession.sessionId).not.toBe(previousSession.sessionId);
    expect(nextSession.sessionMeta?.attributes?.['previousSession']).toBe(previousSession.sessionId);
    expect(sessionStartEvents).toHaveLength(1);
    expect(pressedButton?.meta.session?.id).toBe(nextSession.sessionId);
    instrumentation.unpatch();
  });

  it('stops recording direct activity after session instrumentation is unpatched', async () => {
    const instrumentation = new SessionInstrumentation();
    await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [instrumentation],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const session = getVolatileSession();
    const lastActivity = Date.now() - 10 * 60 * 1000;
    VolatileSessionsManager.storeUserSession({ ...session, lastActivity });

    instrumentation.unpatch();
    notifySessionActivity();

    expect(VolatileSessionsManager.fetchUserSession()?.lastActivity).toBe(lastActivity);
  });
});
