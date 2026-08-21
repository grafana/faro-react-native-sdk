/**
 * Regression coverage for the MMKV loader's version compatibility.
 *
 * `createMmkvInstance` is private; it is exercised lazily via the first call to
 * a static that touches storage (`fetchUserSession` -> `getMmkv`). Each test
 * loads the module in an isolated registry with `react-native-mmkv` mocked to a
 * specific export shape, so we can assert which construction path is taken.
 */

const SESSION_MMKV_CONFIG = { id: 'grafana-faro-react-native-session' };

type SessionsManagerModule = typeof import('./MmkvPersistentSessionsManager');

const loadWithMmkvMock = (
  mmkvExports: Record<string, unknown>,
  storageId: string | null = SESSION_MMKV_CONFIG.id
): SessionsManagerModule => {
  let mod: SessionsManagerModule | undefined;

  jest.isolateModules(() => {
    jest.doMock('react-native-mmkv', () => mmkvExports);
    jest.doMock('../sessionProcess', () => ({
      claimSessionPersistenceStorageId: jest.fn(() => storageId),
    }));
    mod = require('./MmkvPersistentSessionsManager');
  });

  if (!mod) {
    throw new Error('jest.isolateModules did not load MmkvPersistentSessionsManager');
  }

  return mod;
};

describe('MmkvPersistentSessionsManager - react-native-mmkv version compatibility', () => {
  afterEach(() => {
    jest.dontMock('../sessionProcess');
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('uses the createMMKV() factory when available (react-native-mmkv v4+)', () => {
    const store = { getString: jest.fn().mockReturnValue(undefined) };
    const createMMKV = jest.fn().mockReturnValue(store);

    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ createMMKV });
    MmkvPersistentSessionsManager.fetchUserSession();

    expect(createMMKV).toHaveBeenCalledWith(SESSION_MMKV_CONFIG);
  });

  it('falls back to `new MMKV()` when only the class is exported (v2/v3)', () => {
    const store = { getString: jest.fn().mockReturnValue(undefined) };
    const MMKV = jest.fn().mockImplementation(() => store);

    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ MMKV });
    MmkvPersistentSessionsManager.fetchUserSession();

    expect(MMKV).toHaveBeenCalledWith(SESSION_MMKV_CONFIG);
  });

  it('uses delete() to clean up stored state with react-native-mmkv v2/v3', () => {
    const store = {
      getString: jest.fn().mockReturnValue('{not-json'),
      delete: jest.fn(),
    };
    const MMKV = jest.fn().mockImplementation(() => store);

    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ MMKV });
    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();

    expect(store.delete).toHaveBeenCalledWith('com.grafana.faro.session');
  });

  it('prefers createMMKV() over the legacy class when both are present', () => {
    const store = { getString: jest.fn().mockReturnValue(undefined) };
    const createMMKV = jest.fn().mockReturnValue(store);
    const MMKV = jest.fn().mockImplementation(() => store);

    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ createMMKV, MMKV });
    MmkvPersistentSessionsManager.fetchUserSession();

    expect(createMMKV).toHaveBeenCalledWith(SESSION_MMKV_CONFIG);
    expect(MMKV).not.toHaveBeenCalled();
  });

  it('uses a separate MMKV id for a secondary process', () => {
    const store = { getString: jest.fn().mockReturnValue(undefined) };
    const createMMKV = jest.fn().mockReturnValue(store);
    const processStorageId = 'grafana-faro-react-native-session.com.example.myapp%3Async';

    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ createMMKV }, processStorageId);
    MmkvPersistentSessionsManager.fetchUserSession();

    expect(createMMKV).toHaveBeenCalledWith({ id: processStorageId });
  });

  it('does not create MMKV when this runtime cannot claim persistence', () => {
    const createMMKV = jest.fn();
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ createMMKV }, null);
    const session = {
      sessionId: 'runtime-session',
      started: 100,
      lastActivity: 200,
      isSampled: true,
    };

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();
    MmkvPersistentSessionsManager.storeUserSession(session);

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBe(session);
    expect(createMMKV).not.toHaveBeenCalled();
  });

  it('keeps independent process session chains in separate MMKV records', () => {
    const stores = new Map<string, { getString: jest.Mock; set: jest.Mock }>();
    const createMMKV = jest.fn(({ id }: { id: string }) => {
      const values = new Map<string, string>();
      const store = {
        getString: jest.fn((key: string) => values.get(key)),
        set: jest.fn((key: string, value: string) => values.set(key, value)),
      };
      stores.set(id, store);
      return store;
    });
    const workerStorageId = 'grafana-faro-react-native-session.com.example.myapp%3Async';

    const main = loadWithMmkvMock({ createMMKV }, SESSION_MMKV_CONFIG.id);
    main.MmkvPersistentSessionsManager.storeUserSession({
      sessionId: 'main-current',
      started: 100,
      lastActivity: 200,
      isSampled: true,
      sessionMeta: {
        id: 'main-current',
        attributes: { previousSession: 'main-previous' },
      },
    });

    const worker = loadWithMmkvMock({ createMMKV }, workerStorageId);
    worker.MmkvPersistentSessionsManager.storeUserSession({
      sessionId: 'worker-current',
      started: 300,
      lastActivity: 400,
      isSampled: false,
      sessionMeta: {
        id: 'worker-current',
        attributes: { previousSession: 'worker-previous' },
      },
    });

    const mainRecord = JSON.parse(stores.get(SESSION_MMKV_CONFIG.id)?.set.mock.calls[0]?.[1] ?? 'null');
    const workerRecord = JSON.parse(stores.get(workerStorageId)?.set.mock.calls[0]?.[1] ?? 'null');
    expect(mainRecord).toMatchObject({
      currentSessionId: 'main-current',
      previousSessionId: 'main-previous',
    });
    expect(workerRecord).toMatchObject({
      currentSessionId: 'worker-current',
      previousSessionId: 'worker-previous',
    });
  });
});

describe('MmkvPersistentSessionsManager - session persistence', () => {
  afterEach(() => {
    jest.dontMock('../sessionProcess');
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns null when no session has been stored', () => {
    const store = { getString: jest.fn().mockReturnValue(undefined) };
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({
      createMMKV: jest.fn().mockReturnValue(store),
    });

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['corrupt', '{not-json'],
    [
      'unsupported',
      JSON.stringify({
        schemaVersion: 99,
        currentSessionId: 'old-session',
        previousSessionId: null,
        startedAt: 100,
        lastActivityAt: 200,
        isSampled: true,
      }),
    ],
  ])('removes %s stored state', (_name, serialized) => {
    const store = {
      getString: jest.fn().mockReturnValue(serialized),
      remove: jest.fn(),
    };
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({
      createMMKV: jest.fn().mockReturnValue(store),
    });

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();
    expect(store.remove).toHaveBeenCalledWith('com.grafana.faro.session');
  });

  it('stores a minimal record while retaining normalized runtime metadata in memory', () => {
    const store = {
      getString: jest.fn().mockReturnValue(undefined),
      set: jest.fn(),
    };
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({
      createMMKV: jest.fn().mockReturnValue(store),
    });
    const session = {
      sessionId: 'current-session',
      started: 100,
      lastActivity: 200,
      isSampled: true,
      sessionMeta: {
        id: 'current-session',
        attributes: {
          previousSession: 'previous-session',
          custom: 'runtime-only',
          unavailable: undefined,
        },
        overrides: {
          serviceName: 'runtime-only',
        },
      },
    };

    MmkvPersistentSessionsManager.storeUserSession(session);

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toStrictEqual({
      ...session,
      sessionMeta: {
        ...session.sessionMeta,
        attributes: {
          previousSession: 'previous-session',
          custom: 'runtime-only',
        },
      },
    });
    expect(JSON.parse(store.set.mock.calls[0][1])).toStrictEqual({
      schemaVersion: 1,
      currentSessionId: 'current-session',
      previousSessionId: 'previous-session',
      startedAt: 100,
      lastActivityAt: 200,
      isSampled: true,
    });
  });

  it('resolves unavailable MMKV once and retains the live session in memory', () => {
    const createMMKV = jest.fn(() => {
      throw new Error('native module unavailable');
    });
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({ createMMKV });
    const session = {
      sessionId: 'current-session',
      started: 100,
      lastActivity: 200,
      isSampled: true,
    };

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();
    MmkvPersistentSessionsManager.storeUserSession(session);

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBe(session);
    expect(createMMKV).toHaveBeenCalledTimes(1);
  });

  it('retains the live session when an MMKV write fails', () => {
    const store = {
      getString: jest.fn().mockReturnValue(undefined),
      set: jest.fn(() => {
        throw new Error('write failed');
      }),
    };
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({
      createMMKV: jest.fn().mockReturnValue(store),
    });
    const session = {
      sessionId: 'current-session',
      started: 100,
      lastActivity: 200,
      isSampled: true,
    };

    MmkvPersistentSessionsManager.storeUserSession(session);

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBe(session);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('does not delete stored state when reading MMKV fails', () => {
    const store = {
      getString: jest.fn(() => {
        throw new Error('read failed');
      }),
      remove: jest.fn(),
      delete: jest.fn(),
    };
    const { MmkvPersistentSessionsManager } = loadWithMmkvMock({
      createMMKV: jest.fn().mockReturnValue(store),
    });

    expect(MmkvPersistentSessionsManager.fetchUserSession()).toBeNull();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('updates activity in memory immediately and coalesces MMKV writes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));

    try {
      const store = {
        getString: jest.fn().mockReturnValue(undefined),
        set: jest.fn(),
      };
      jest.doMock('react-native-mmkv', () => ({ createMMKV: jest.fn().mockReturnValue(store) }));

      const { mockConfig, MockTransport } = require('@grafana/faro-test-utils');
      const { initializeFaro } = require('../../../initialize');
      const { EVENT_NAVIGATION } = require('../../../navigation/utils');
      const { SessionInstrumentation } = require('../index');
      const { MmkvPersistentSessionsManager } = require('./MmkvPersistentSessionsManager');
      const faro = await initializeFaro(
        mockConfig({
          url: 'http://localhost:12345/collect',
          transports: [new MockTransport()],
          instrumentations: [new SessionInstrumentation()],
          sessionTracking: { enabled: true, persistent: true },
        })
      );
      const instrumentation = faro.instrumentations.instrumentations.find(
        ({ name }: { name: string }) => name === '@grafana/faro-react-native:instrumentation-session'
      );
      if (instrumentation == null || typeof instrumentation.unpatch !== 'function') {
        throw new Error('Expected the default session instrumentation.');
      }
      const writesAfterInitialization = store.set.mock.calls.length;

      jest.advanceTimersByTime(1);
      faro.api.pushEvent(EVENT_NAVIGATION, { screen: 'cart' });
      const activityAfterFirstEvent = MmkvPersistentSessionsManager.fetchUserSession().lastActivity;
      jest.advanceTimersByTime(1);
      faro.api.pushEvent(EVENT_NAVIGATION, { screen: 'checkout' });

      expect(activityAfterFirstEvent).toBe(Date.now() - 1);
      expect(MmkvPersistentSessionsManager.fetchUserSession().lastActivity).toBe(Date.now());
      expect(store.set).toHaveBeenCalledTimes(writesAfterInitialization + 1);

      jest.advanceTimersByTime(999);
      expect(store.set).toHaveBeenCalledTimes(writesAfterInitialization + 2);

      faro.api.pushEvent(EVENT_NAVIGATION, { screen: 'confirmation' });
      instrumentation.unpatch();
      expect(store.set).toHaveBeenCalledTimes(writesAfterInitialization + 3);

      jest.advanceTimersByTime(1000);
      expect(store.set).toHaveBeenCalledTimes(writesAfterInitialization + 3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushes pending activity when the app enters the background', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));

    try {
      const store = {
        getString: jest.fn().mockReturnValue(undefined),
        set: jest.fn(),
      };
      jest.doMock('react-native-mmkv', () => ({ createMMKV: jest.fn().mockReturnValue(store) }));

      const { mockConfig } = require('@grafana/faro-test-utils');
      const { initializeFaro } = require('../../../initialize');
      const { SessionActivityKind } = require('../sessionActivity');
      const { MmkvPersistentSessionsManager } = require('./MmkvPersistentSessionsManager');
      await initializeFaro(
        mockConfig({
          url: 'http://localhost:12345/collect',
          instrumentations: [],
          sessionTracking: { enabled: true, persistent: true },
        })
      );
      const manager = new MmkvPersistentSessionsManager();
      MmkvPersistentSessionsManager.storeUserSession({
        sessionId: 'current-session',
        started: Date.now() - 1000,
        lastActivity: Date.now() - 1000,
        isSampled: true,
      });
      const writesAfterStore = store.set.mock.calls.length;

      manager.checkSession(SessionActivityKind.Meaningful);
      jest.advanceTimersByTime(1);
      manager.checkSession(SessionActivityKind.Meaningful);
      expect(store.set).toHaveBeenCalledTimes(writesAfterStore + 1);

      (
        manager as unknown as {
          handleAppStateChange: (state: 'background') => void;
        }
      ).handleAppStateChange('background');
      expect(store.set).toHaveBeenCalledTimes(writesAfterStore + 2);

      manager.unpatch();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rotates the persistent session at the inactivity boundary before attribution', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));

    try {
      const store = {
        getString: jest.fn().mockReturnValue(undefined),
        set: jest.fn(),
      };
      jest.doMock('react-native-mmkv', () => ({ createMMKV: jest.fn().mockReturnValue(store) }));

      const { TransportItemType } = require('@grafana/faro-core');
      const { mockConfig, MockTransport } = require('@grafana/faro-test-utils');
      const { initializeFaro } = require('../../../initialize');
      const { SessionInstrumentation } = require('../index');
      const { MmkvPersistentSessionsManager } = require('./MmkvPersistentSessionsManager');
      const transport = new MockTransport();
      const faro = await initializeFaro(
        mockConfig({
          url: 'http://localhost:12345/collect',
          transports: [transport],
          instrumentations: [new SessionInstrumentation()],
          sessionTracking: { enabled: true, persistent: true },
        })
      );
      const previousSession = MmkvPersistentSessionsManager.fetchUserSession();
      if (previousSession == null) {
        throw new Error('Expected an active persistent session.');
      }
      MmkvPersistentSessionsManager.storeUserSession({
        ...previousSession,
        lastActivity: Date.now() - 15 * 60 * 1000,
      });

      faro.api.pushEvent('poll_complete');

      const nextSession = MmkvPersistentSessionsManager.fetchUserSession();
      const sentEvent = transport.items.find(
        (item: { type: string; payload: { name?: string } }) =>
          item.type === TransportItemType.EVENT && item.payload.name === 'poll_complete'
      );
      expect(nextSession?.sessionId).not.toBe(previousSession.sessionId);
      expect(nextSession?.sessionMeta?.attributes?.['previousSession']).toBe(previousSession.sessionId);
      expect(sentEvent?.meta.session?.id).toBe(nextSession?.sessionId);
    } finally {
      jest.useRealTimers();
    }
  });
});
