import { AppState, type AppStateStatus } from 'react-native';
import type { MMKV } from 'react-native-mmkv';

import { faro } from '@grafana/faro-core';

import { throttle } from '../../../utils/throttle';

import { parsePersistentSession, serializePersistentSession } from './persistentSessionRecord';
import { STORAGE_KEY, STORAGE_UPDATE_DELAY } from './sessionConstants';
import { getSessionMetaUpdateHandler, getUserSessionUpdater, toStorableSessionMeta } from './sessionManagerUtils';
import type { FaroUserSession } from './types';

function createMmkvInstance(): MMKV {
  try {
    const mmkv = require('react-native-mmkv');
    // react-native-mmkv v4 was rewritten to Nitro and removed the `new MMKV()`
    // class constructor in favor of a `createMMKV()` factory (see the v4 upgrade
    // guide). Support both so v2/v3 (class) and v4+ (factory) work.
    if (typeof mmkv.createMMKV === 'function') {
      return mmkv.createMMKV({ id: 'grafana-faro-react-native-session' });
    }
    return new mmkv.MMKV({ id: 'grafana-faro-react-native-session' });
  } catch {
    throw new Error(
      'sessionTracking.persistent is true but react-native-mmkv could not be loaded. Install it: yarn add react-native-mmkv, then rebuild native projects.'
    );
  }
}

// undefined means MMKV has not been resolved; null means it is unavailable.
let mmkvSingleton: MMKV | null | undefined;
// undefined means storage has not been read, null means no persisted state is
// available, and a session is the live value for this JavaScript runtime.
let runtimeSession: FaroUserSession | null | undefined;

function tryGetMmkv(): MMKV | null {
  if (mmkvSingleton !== undefined) {
    return mmkvSingleton;
  }

  try {
    mmkvSingleton = createMmkvInstance();
  } catch (error) {
    mmkvSingleton = null;
    faro.unpatchedConsole?.warn?.('Session persistence is unavailable; using an in-memory session:', error);
  }

  return mmkvSingleton;
}

function removeMmkvValue(mmkv: MMKV, key: string): void {
  const compatibleMmkv = mmkv as MMKV & {
    delete?: (storageKey: string) => void;
    remove?: (storageKey: string) => void;
  };

  if (typeof compatibleMmkv.remove === 'function') {
    compatibleMmkv.remove(key);
    return;
  }
  if (typeof compatibleMmkv.delete === 'function') {
    compatibleMmkv.delete(key);
    return;
  }

  throw new Error('The installed react-native-mmkv version cannot remove stored values.');
}

/** @internal */
export function resetMmkvSingletonForTests(): void {
  mmkvSingleton = undefined;
  runtimeSession = undefined;
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
    runtimeSession = null;
    const mmkv = tryGetMmkv();
    if (mmkv == null) {
      return;
    }
    try {
      removeMmkvValue(mmkv, STORAGE_KEY);
    } catch (error) {
      faro.unpatchedConsole?.warn?.('Failed to remove session from MMKV:', error);
    }
  }

  static storeUserSession(session: FaroUserSession): void {
    runtimeSession =
      session.sessionMeta == null
        ? session
        : {
            ...session,
            sessionMeta: toStorableSessionMeta(session.sessionMeta),
          };
    const mmkv = tryGetMmkv();
    if (mmkv == null) {
      return;
    }
    try {
      mmkv.set(STORAGE_KEY, serializePersistentSession(session));
    } catch (error) {
      faro.unpatchedConsole?.warn?.('Failed to store session in MMKV:', error);
    }
  }

  static fetchUserSession(): FaroUserSession | null {
    if (runtimeSession !== undefined) {
      return runtimeSession;
    }

    const mmkv = tryGetMmkv();
    if (mmkv == null) {
      runtimeSession = null;
      return null;
    }

    try {
      const storedSession = mmkv.getString(STORAGE_KEY);
      if (storedSession == null) {
        runtimeSession = null;
        return null;
      }

      runtimeSession = parsePersistentSession(storedSession);
      if (runtimeSession == null) {
        removeMmkvValue(mmkv, STORAGE_KEY);
      }
      return runtimeSession;
    } catch (error) {
      runtimeSession = null;
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
