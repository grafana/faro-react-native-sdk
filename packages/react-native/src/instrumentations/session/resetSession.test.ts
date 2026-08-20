import { EVENT_SESSION_START, initializeFaro } from '@grafana/faro-core';
import type { Faro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingFunction } from '../../config/sampling';

import { resetSession, SessionInstrumentation } from './index';
import {
  MmkvPersistentSessionsManager,
  resetMmkvSingletonForTests,
} from './sessionManager/MmkvPersistentSessionsManager';
import { STORAGE_KEY } from './sessionManager/sessionConstants';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

const mockMmkvValues = new Map<string, string>();
const mockMmkv = {
  getString: jest.fn((key: string) => mockMmkvValues.get(key)),
  set: jest.fn((key: string, value: string) => mockMmkvValues.set(key, value)),
  remove: jest.fn((key: string) => mockMmkvValues.delete(key)),
};

jest.mock('react-native-mmkv', () => ({
  createMMKV: jest.fn(() => mockMmkv),
}));

const initialTime = new Date('2026-08-20T12:00:00.000Z').getTime();

type InitializeSessionOptions = {
  persistent: boolean;
  sessionIds?: string[];
  samplingRates?: number[];
  onSessionChange?: jest.Mock;
};

function initializeSession({
  persistent,
  sessionIds = ['session-1', 'session-2', 'session-3'],
  samplingRates = [1, 1, 1],
  onSessionChange = jest.fn(),
}: InitializeSessionOptions) {
  const remainingSessionIds = [...sessionIds];
  const generateSessionId = jest.fn(() => remainingSessionIds.shift() ?? 'fallback-session');
  const resolveSampling = jest.fn(() => samplingRates.shift() ?? 1);
  const transport = new MockTransport();
  const instrumentation = new SessionInstrumentation();
  const faro = initializeFaro(
    mockConfig({
      transports: [transport],
      instrumentations: [instrumentation],
      sessionTracking: {
        enabled: true,
        persistent,
        generateSessionId,
        onSessionChange,
        sampling: new SamplingFunction(resolveSampling),
      },
    })
  );

  return { faro, generateSessionId, instrumentation, onSessionChange, resolveSampling, transport };
}

function sessionStartItems(transport: MockTransport) {
  return transport.items.filter(
    (item) => item.type === 'event' && 'name' in item.payload && item.payload.name === EVENT_SESSION_START
  );
}

describe('resetSession', () => {
  const initializedFaros: Faro[] = [];

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    jest.setSystemTime(initialTime);
    jest.clearAllMocks();
    mockMmkvValues.clear();
    resetMmkvSingletonForTests();
    VolatileSessionsManager.removeUserSession();
  });

  afterEach(() => {
    for (const faro of initializedFaros.splice(0)) {
      for (const instrumentation of faro.instrumentations.instrumentations) {
        instrumentation.unpatch?.();
      }
    }
    delete (globalThis as Record<string, unknown>)['faro'];
    jest.restoreAllMocks();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it.each([
    ['volatile', false],
    ['persistent', true],
  ])('starts and links a new %s session on every reset', (_mode, persistent) => {
    const setup = initializeSession({ persistent });
    initializedFaros.push(setup.faro);
    const initialSession = setup.faro.api.getSession();
    const sessionsAtActionEnd: Array<string | undefined> = [];
    const activeAction = {
      end: jest.fn(() => sessionsAtActionEnd.push(setup.faro.api.getSession()?.id)),
    };
    jest.spyOn(setup.faro.api, 'getActiveUserAction').mockReturnValue(activeAction as never);

    jest.setSystemTime(initialTime + 60_000);
    resetSession();
    const secondSession = setup.faro.api.getSession();
    const secondStoredSession = persistent
      ? MmkvPersistentSessionsManager.fetchUserSession()
      : VolatileSessionsManager.fetchUserSession();

    jest.setSystemTime(initialTime + 120_000);
    resetSession();
    const thirdSession = setup.faro.api.getSession();
    const thirdStoredSession = persistent
      ? MmkvPersistentSessionsManager.fetchUserSession()
      : VolatileSessionsManager.fetchUserSession();

    expect(initialSession?.id).toBe('session-1');
    expect(secondSession).toMatchObject({
      id: 'session-2',
      attributes: { previousSession: 'session-1' },
    });
    expect(secondStoredSession).toMatchObject({
      sessionId: 'session-2',
      started: initialTime + 60_000,
      lastActivity: initialTime + 60_000,
    });
    expect(thirdSession).toMatchObject({
      id: 'session-3',
      attributes: { previousSession: 'session-2' },
    });
    expect(thirdStoredSession).toMatchObject({
      sessionId: 'session-3',
      started: initialTime + 120_000,
      lastActivity: initialTime + 120_000,
    });
    expect(sessionStartItems(setup.transport).map((item) => item.meta.session?.id)).toStrictEqual([
      'session-1',
      'session-2',
      'session-3',
    ]);
    expect(setup.onSessionChange).toHaveBeenNthCalledWith(1, initialSession, secondSession);
    expect(setup.onSessionChange).toHaveBeenNthCalledWith(2, secondSession, thirdSession);
    expect(activeAction.end).toHaveBeenCalledTimes(2);
    expect(sessionsAtActionEnd).toStrictEqual(['session-1', 'session-2']);

    if (persistent) {
      expect(JSON.parse(mockMmkvValues.get(STORAGE_KEY) ?? '')).toMatchObject({
        currentSessionId: 'session-3',
        previousSessionId: 'session-2',
        startedAt: initialTime + 120_000,
        lastActivityAt: initialTime + 120_000,
      });
    }
  });

  it('makes a fresh sampling decision for every reset', () => {
    const setup = initializeSession({ persistent: false, samplingRates: [1, 0, 1] });
    initializedFaros.push(setup.faro);

    expect(VolatileSessionsManager.fetchUserSession()?.isSampled).toBe(true);
    resetSession();
    expect(VolatileSessionsManager.fetchUserSession()?.isSampled).toBe(false);
    resetSession();
    expect(VolatileSessionsManager.fetchUserSession()?.isSampled).toBe(true);
    expect(setup.resolveSampling).toHaveBeenCalledTimes(3);
  });

  it('uses a different ID when a custom generator repeats the current ID', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const setup = initializeSession({ persistent: false, sessionIds: ['same-session', 'same-session'] });
    initializedFaros.push(setup.faro);

    resetSession();

    expect(setup.faro.api.getSession()?.id).not.toBe('same-session');
    expect(setup.faro.api.getSession()?.attributes?.['previousSession']).toBe('same-session');
    expect(warn).toHaveBeenCalledWith(
      'The session ID generator returned the current session ID; using a generated fallback for the new session.'
    );
  });

  it('ignores a reset triggered re-entrantly by onSessionChange', () => {
    const onSessionChange = jest.fn(() => resetSession());
    const setup = initializeSession({ persistent: false, onSessionChange });
    initializedFaros.push(setup.faro);

    resetSession();

    expect(setup.faro.api.getSession()?.id).toBe('session-2');
    expect(setup.generateSessionId).toHaveBeenCalledTimes(2);
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('does nothing when session tracking is disabled', () => {
    const instrumentation = new SessionInstrumentation();
    const transport = new MockTransport();
    const faro = initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [instrumentation],
        sessionTracking: { enabled: false },
      })
    );
    initializedFaros.push(faro);

    resetSession();

    expect(faro.api.getSession()).toBeUndefined();
    expect(sessionStartItems(transport)).toHaveLength(0);
  });

  it('does nothing after the session instrumentation is unpatched', () => {
    const setup = initializeSession({ persistent: false });
    initializedFaros.push(setup.faro);
    setup.instrumentation.unpatch();

    resetSession();

    expect(setup.faro.api.getSession()?.id).toBe('session-1');
    expect(setup.generateSessionId).toHaveBeenCalledTimes(1);
  });
});
