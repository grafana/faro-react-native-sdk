import { AppState, type AppStateStatus } from 'react-native';

import { faro, stringifyExternalJson } from '@grafana/faro-core';

import { throttle } from '../../../utils/throttle';

import { STORAGE_KEY, STORAGE_UPDATE_DELAY } from './sessionConstants';
import { getSessionMetaUpdateHandler, getUserSessionUpdater } from './sessionManagerUtils';
import type { FaroUserSession } from './types';

function createMmkvInstance(): import('react-native-mmkv').MMKV {
  try {
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    return new MMKV({ id: 'grafana-faro-react-native-session' });
  } catch {
    throw new Error(
      'sessionTracking.persistent is true but react-native-mmkv could not be loaded. Install it: yarn add react-native-mmkv, then rebuild native projects.'
    );
  }
}

let mmkvSingleton: import('react-native-mmkv').MMKV | undefined;

function getMmkv(): import('react-native-mmkv').MMKV {
  if (mmkvSingleton == null) {
    mmkvSingleton = createMmkvInstance();
  }
  return mmkvSingleton;
}

/** @internal */
export function resetMmkvSingletonForTests(): void {
  mmkvSingleton = undefined;
}

/**
 * Persistent session storage backed by MMKV (synchronous reads/writes).
 * Used when `sessionTracking.persistent` is true.
 */
export class MmkvPersistentSessionsManager {
  private updateUserSession: ReturnType<typeof getUserSessionUpdater>;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private metaUnsubscribe: (() => void) | null = null;

  constructor() {
    this.updateUserSession = getUserSessionUpdater({
      fetchUserSession: MmkvPersistentSessionsManager.fetchUserSession,
      storeUserSession: MmkvPersistentSessionsManager.storeUserSession,
    });

    this.init();
  }

  static removeUserSession(): void {
    try {
      getMmkv().delete(STORAGE_KEY);
    } catch (error) {
      faro.unpatchedConsole?.warn?.('Failed to remove session from MMKV:', error);
    }
  }

  static storeUserSession(session: FaroUserSession): void {
    try {
      getMmkv().set(STORAGE_KEY, stringifyExternalJson(session));
    } catch (error) {
      faro.unpatchedConsole?.warn?.('Failed to store session in MMKV:', error);
    }
  }

  static fetchUserSession(): FaroUserSession | null {
    try {
      const storedSession = getMmkv().getString(STORAGE_KEY);
      if (storedSession) {
        return JSON.parse(storedSession) as FaroUserSession;
      }
      return null;
    } catch (error) {
      faro.unpatchedConsole?.warn?.('Failed to fetch session from MMKV:', error);
      return null;
    }
  }

  updateSession = throttle(() => this.updateUserSession(), STORAGE_UPDATE_DELAY);

  private handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (nextAppState === 'active') {
      this.updateSession();
    }
  };

  private init(): void {
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);

    const unsubscribe = faro.metas.addListener(
      getSessionMetaUpdateHandler({
        fetchUserSession: MmkvPersistentSessionsManager.fetchUserSession,
        storeUserSession: MmkvPersistentSessionsManager.storeUserSession,
      })
    );
    this.metaUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
  }

  unpatch(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    if (this.metaUnsubscribe) {
      this.metaUnsubscribe();
      this.metaUnsubscribe = null;
    }
  }
}
