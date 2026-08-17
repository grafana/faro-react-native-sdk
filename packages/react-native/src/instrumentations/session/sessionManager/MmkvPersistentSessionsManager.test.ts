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

const loadWithMmkvMock = (mmkvExports: Record<string, unknown>): SessionsManagerModule => {
  let mod: SessionsManagerModule | undefined;

  jest.isolateModules(() => {
    jest.doMock('react-native-mmkv', () => mmkvExports);
    mod = require('./MmkvPersistentSessionsManager');
  });

  if (!mod) {
    throw new Error('jest.isolateModules did not load MmkvPersistentSessionsManager');
  }

  return mod;
};

describe('MmkvPersistentSessionsManager - react-native-mmkv version compatibility', () => {
  afterEach(() => {
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
});

describe('MmkvPersistentSessionsManager - session persistence', () => {
  afterEach(() => {
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
});
