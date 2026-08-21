import { NativeModules } from 'react-native';

import {
  claimSessionPersistenceStorageId,
  getSessionProcessInfo,
  MAIN_PROCESS_SESSION_STORAGE_ID,
  resetSessionProcessForTests,
} from './sessionProcess';

const originalNativeModule = NativeModules.FaroReactNativeModule;

function setNativeModule(overrides: Record<string, unknown> = {}): {
  claimSessionPersistence: jest.Mock;
  getSessionProcessIdentifier: jest.Mock;
  isMainSessionProcess: jest.Mock;
} {
  const nativeModule = {
    claimSessionPersistence: jest.fn(() => true),
    getSessionProcessIdentifier: jest.fn(() => 'com.example.myapp'),
    isMainSessionProcess: jest.fn(() => true),
    ...overrides,
  };
  NativeModules.FaroReactNativeModule = nativeModule;
  return nativeModule;
}

describe('sessionProcess', () => {
  beforeEach(() => {
    resetSessionProcessForTests();
    setNativeModule();
  });

  afterAll(() => {
    NativeModules.FaroReactNativeModule = originalNativeModule;
    resetSessionProcessForTests();
  });

  it('keeps the legacy MMKV id for the main process', () => {
    const nativeModule = setNativeModule();

    expect(claimSessionPersistenceStorageId()).toBe(MAIN_PROCESS_SESSION_STORAGE_ID);
    expect(claimSessionPersistenceStorageId()).toBe(MAIN_PROCESS_SESSION_STORAGE_ID);
    expect(nativeModule.claimSessionPersistence).toHaveBeenCalledTimes(1);
  });

  it('uses a separate stable MMKV id for a secondary process', () => {
    setNativeModule({
      getSessionProcessIdentifier: jest.fn(() => 'com.example.myapp:sync worker'),
      isMainSessionProcess: jest.fn(() => false),
    });

    expect(claimSessionPersistenceStorageId()).toBe(
      `${MAIN_PROCESS_SESSION_STORAGE_ID}.com.example.myapp%3Async%20worker`
    );
    expect(getSessionProcessInfo()).toEqual({
      identifier: 'com.example.myapp:sync worker',
      isMain: false,
    });
  });

  it('caches the native process identity for this JavaScript runtime', () => {
    const nativeModule = setNativeModule();

    expect(getSessionProcessInfo()).toEqual({ identifier: 'com.example.myapp', isMain: true });
    expect(getSessionProcessInfo()).toEqual({ identifier: 'com.example.myapp', isMain: true });
    expect(nativeModule.getSessionProcessIdentifier).toHaveBeenCalledTimes(1);
    expect(nativeModule.isMainSessionProcess).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the native process bridge is unavailable', () => {
    NativeModules.FaroReactNativeModule = undefined;
    resetSessionProcessForTests();

    expect(getSessionProcessInfo()).toBeNull();
    expect(claimSessionPersistenceStorageId()).toBeNull();
  });

  it.each([
    ['empty identity', { getSessionProcessIdentifier: jest.fn(() => '  ') }],
    ['invalid main-process result', { isMainSessionProcess: jest.fn(() => null) }],
    [
      'identity lookup failure',
      {
        getSessionProcessIdentifier: jest.fn(() => {
          throw new Error('unavailable');
        }),
      },
    ],
  ])('fails closed for %s', (_name, overrides) => {
    const nativeModule = setNativeModule(overrides);

    expect(getSessionProcessInfo()).toBeNull();
    expect(claimSessionPersistenceStorageId()).toBeNull();
    expect(nativeModule.claimSessionPersistence).not.toHaveBeenCalled();
  });

  it('falls back to in-memory sessions when another runtime owns persistence', () => {
    const nativeModule = setNativeModule({ claimSessionPersistence: jest.fn(() => false) });

    expect(claimSessionPersistenceStorageId()).toBeNull();
    expect(claimSessionPersistenceStorageId()).toBeNull();
    expect(nativeModule.claimSessionPersistence).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the persistence claim throws', () => {
    setNativeModule({
      claimSessionPersistence: jest.fn(() => {
        throw new Error('native failure');
      }),
    });

    expect(claimSessionPersistenceStorageId()).toBeNull();
  });
});
