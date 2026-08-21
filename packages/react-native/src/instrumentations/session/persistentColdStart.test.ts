import { NativeModules } from 'react-native';

import { EVENT_SESSION_START, initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SessionInstrumentation } from './index';
import {
  MmkvPersistentSessionsManager,
  resetMmkvSingletonForTests,
} from './sessionManager/MmkvPersistentSessionsManager';
import { MAX_SESSION_PERSISTENCE_TIME, STORAGE_KEY } from './sessionManager/sessionConstants';
import { resetSessionProcessForTests } from './sessionProcess';

const mockMmkvValues = new Map<string, string>();
const mockMmkv = {
  getString: jest.fn((key: string) => mockMmkvValues.get(key)),
  set: jest.fn((key: string, value: string) => mockMmkvValues.set(key, value)),
  remove: jest.fn((key: string) => mockMmkvValues.delete(key)),
};
const mockCreateMMKV = jest.fn(() => mockMmkv);
const originalNativeModule = NativeModules.FaroReactNativeModule;

jest.mock('react-native-mmkv', () => ({
  createMMKV: mockCreateMMKV,
}));

const now = new Date('2026-08-14T12:00:00.000Z').getTime();

function persistedSession({
  currentSessionId = 'persisted-session',
  startedAt = now - 10_000,
  lastActivityAt = now - 1,
}: {
  currentSessionId?: string;
  startedAt?: number;
  lastActivityAt?: number;
} = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    currentSessionId,
    previousSessionId: 'older-session',
    startedAt,
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
    NativeModules.FaroReactNativeModule = {
      claimSessionPersistence: () => true,
      getSessionProcessIdentifier: () => 'com.example.myapp',
      isMainSessionProcess: () => true,
      releaseSessionPersistence: () => true,
    };
    jest.clearAllMocks();
    mockMmkvValues.clear();
    resetMmkvSingletonForTests();
    resetSessionProcessForTests();
    delete (globalThis as Record<string, unknown>)['faro'];
  });

  afterAll(() => {
    NativeModules.FaroReactNativeModule = originalNativeModule;
    resetSessionProcessForTests();
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
    const sessionStartEvents = transport.items.filter(
      (item) => item.type === 'event' && 'name' in item.payload && item.payload.name === EVENT_SESSION_START
    );
    expect(sessionStartEvents).toHaveLength(1);
    expect(sessionStartEvents[0]?.meta.session?.attributes?.['previousSession']).toBe('persisted-session');
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
    const lastActivityAt = now - MAX_SESSION_PERSISTENCE_TIME;
    mockMmkvValues.set(STORAGE_KEY, persistedSession({ startedAt: lastActivityAt - 10_000, lastActivityAt }));

    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
    expect(mockMmkv.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('does not link future-dated persisted state', () => {
    mockMmkvValues.set(STORAGE_KEY, persistedSession({ startedAt: now + 1, lastActivityAt: now + 1 }));

    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
    expect(mockMmkv.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('does not link a configured session ID to itself', () => {
    mockMmkvValues.set(STORAGE_KEY, persistedSession({ currentSessionId: 'new-session' }));

    const { faro } = initializePersistentSession();

    expect(faro.metas.value.session?.id).toBe('new-session');
    expect(faro.metas.value.session?.attributes?.['previousSession']).toBeUndefined();
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

    const storedSession = mockMmkvValues.get(STORAGE_KEY);
    expect(storedSession).toBeDefined();
    expect(JSON.parse(storedSession ?? '')).toStrictEqual({
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
