import { EVENT_SESSION_START, initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SessionInstrumentation } from './index';
import {
  MmkvPersistentSessionsManager,
  resetMmkvSingletonForTests,
} from './sessionManager/MmkvPersistentSessionsManager';
import { MAX_SESSION_PERSISTENCE_TIME, STORAGE_KEY } from './sessionManager/sessionConstants';

const mockMmkvValues = new Map<string, string>();
const mockMmkv = {
  getString: jest.fn((key: string) => mockMmkvValues.get(key)),
  set: jest.fn((key: string, value: string) => mockMmkvValues.set(key, value)),
  remove: jest.fn((key: string) => mockMmkvValues.delete(key)),
};
const mockCreateMMKV = jest.fn(() => mockMmkv);

jest.mock('react-native-mmkv', () => ({
  createMMKV: mockCreateMMKV,
}));

const now = new Date('2026-08-14T12:00:00.000Z').getTime();

function persistedSession(lastActivityAt = now - 1) {
  return JSON.stringify({
    schemaVersion: 1,
    currentSessionId: 'persisted-session',
    previousSessionId: 'older-session',
    startedAt: now - 10_000,
    lastActivityAt,
    isSampled: false,
  });
}

function initializePersistentSession() {
  const transport = new MockTransport();
  const faro = initializeFaro(
    mockConfig({
      transports: [transport],
      instrumentations: [new SessionInstrumentation()],
      sessionTracking: {
        enabled: true,
        persistent: true,
        generateSessionId: () => 'new-session',
      },
    })
  );

  return { faro, transport };
}

describe('persistent session cold starts', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMmkvValues.clear();
    resetMmkvSingletonForTests();
    delete (globalThis as Record<string, unknown>)['faro'];
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('starts an unlinked session when stored state is missing', () => {
    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
  });

  it('creates a new session linked to a valid persisted session', () => {
    mockMmkvValues.set(STORAGE_KEY, persistedSession());

    const { faro, transport } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBe('persisted-session');
    expect(
      transport.items.filter((item) => item.type === 'event' && item.payload.name === EVENT_SESSION_START)
    ).toHaveLength(1);
  });

  it('does not load MMKV when persistence is disabled', () => {
    initializeFaro(
      mockConfig({
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(mockCreateMMKV).not.toHaveBeenCalled();
  });

  it('does not link expired persisted state', () => {
    mockMmkvValues.set(STORAGE_KEY, persistedSession(now - MAX_SESSION_PERSISTENCE_TIME));

    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
    expect(mockMmkv.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it.each([
    ['corrupt', '{not-json'],
    [
      'unsupported',
      JSON.stringify({
        schemaVersion: 99,
        currentSessionId: 'persisted-session',
        previousSessionId: null,
        startedAt: now - 10_000,
        lastActivityAt: now - 1,
        isSampled: true,
      }),
    ],
  ])('starts cleanly when persisted state is %s', (_name, value) => {
    mockMmkvValues.set(STORAGE_KEY, value);

    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
    expect(mockMmkv.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('stores only the new session and its link after initialization', () => {
    mockMmkvValues.set(STORAGE_KEY, persistedSession());

    initializePersistentSession();

    expect(JSON.parse(mockMmkvValues.get(STORAGE_KEY)!)).toStrictEqual({
      schemaVersion: 1,
      currentSessionId: 'new-session',
      previousSessionId: 'persisted-session',
      startedAt: now,
      lastActivityAt: now,
      isSampled: true,
    });
    expect(MmkvPersistentSessionsManager.fetchUserSession()?.sessionId).toBe('new-session');
  });
});
