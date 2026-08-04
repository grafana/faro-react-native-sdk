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
