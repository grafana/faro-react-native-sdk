import { AppState, type AppStateStatus, Platform } from 'react-native';
import type { MMKV } from 'react-native-mmkv';

import { dateNow, faro } from '@grafana/faro-core';
import type { Metas } from '@grafana/faro-core';

import { SessionActivityKind } from '../sessionActivity';
import {
  claimSessionPersistenceStorageId,
  getSessionProcessInfo,
  releaseSessionPersistenceOwnership,
} from '../sessionProcess';

import { parsePersistentSession, serializePersistentSession } from './persistentSessionRecord';
import { STORAGE_KEY, STORAGE_UPDATE_DELAY } from './sessionConstants';
import {
  getSessionMetaUpdateHandler,
  getUserSessionResetter,
  getUserSessionUpdater,
  toStorableSessionMeta,
} from './sessionManagerUtils';
import type { FaroUserSession } from './types';

type MmkvConfiguration = {
  id: string;
  mode?: number | 'multi-process';
};

type MmkvModule = {
  createMMKV?: (configuration: MmkvConfiguration) => MMKV;
  MMKV?: new (configuration: MmkvConfiguration) => MMKV;
  Mode?: { MULTI_PROCESS?: number };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadMmkvModule(): MmkvModule {
  try {
    return require('react-native-mmkv') as MmkvModule;
  } catch (error) {
    throw new Error(
      `react-native-mmkv could not be loaded. Install it and rebuild the native project. ${errorMessage(error)}`
    );
  }
}

function mmkvConfiguration(mmkv: MmkvModule, storageId: string, isIosExtension: boolean): MmkvConfiguration {
  if (!isIosExtension) {
    return { id: storageId };
  }

  if (typeof mmkv.createMMKV === 'function') {
    return { id: storageId, mode: 'multi-process' };
  }

  const legacyMultiProcessMode = mmkv.Mode?.MULTI_PROCESS;
  if (typeof legacyMultiProcessMode !== 'number') {
    throw new Error('Persisting sessions in an iOS extension requires react-native-mmkv v3 or newer.');
  }

  return { id: storageId, mode: legacyMultiProcessMode };
}

function createMmkvInstance(): MMKV {
  // Load MMKV before taking native ownership so a missing dependency cannot
  // leave the process-wide claim occupied.
  const mmkv = loadMmkvModule();
  const processInfo = getSessionProcessInfo();
  const storageId = claimSessionPersistenceStorageId();
  if (storageId == null || processInfo == null) {
    throw new Error(
      'Native session-storage coordination is unavailable or already owned by another runtime. Rebuild the native app after upgrading Faro, or use sessionTracking.persistent=false in runtimes that cannot own storage.'
    );
  }

  try {
    const configuration = mmkvConfiguration(mmkv, storageId, Platform.OS === 'ios' && !processInfo.isMain);
    // react-native-mmkv v4 was rewritten to Nitro and removed the `new MMKV()`
    // class constructor in favor of a `createMMKV()` factory (see the v4 upgrade
    // guide). Support both so v2/v3 (class) and v4+ (factory) work.
    if (typeof mmkv.createMMKV === 'function') {
      return mmkv.createMMKV(configuration);
    }
    if (typeof mmkv.MMKV !== 'function') {
      throw new Error('The installed react-native-mmkv package does not expose a supported storage API.');
    }
    return new mmkv.MMKV(configuration);
  } catch (error) {
    releaseSessionPersistenceOwnership();
    throw new Error(`Session persistence could not be initialized. ${errorMessage(error)}`);
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
  private resetUserSession: ReturnType<typeof getUserSessionResetter>;
  private updateUserSession: ReturnType<typeof getUserSessionUpdater>;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private activityWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingActivityWrite = false;
  private lastActivityWrite = 0;
  private wasBackgrounded = AppState.currentState === 'background';
  private metaUpdateHandler: ReturnType<typeof getSessionMetaUpdateHandler> | null = null;
  private registeredMetas: Metas | null = null;

  constructor() {
    this.updateUserSession = getUserSessionUpdater({
      fetchUserSession: MmkvPersistentSessionsManager.fetchUserSession,
      recordUserSessionActivity: this.recordUserSessionActivity,
      storeUserSession: MmkvPersistentSessionsManager.storeUserSession,
    });
    this.resetUserSession = getUserSessionResetter({
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
    MmkvPersistentSessionsManager.setRuntimeSession(session);
    MmkvPersistentSessionsManager.persistSession(session);
  }

  private static setRuntimeSession(session: FaroUserSession): void {
    runtimeSession =
      session.sessionMeta == null
        ? session
        : {
            ...session,
            sessionMeta: toStorableSessionMeta(session.sessionMeta),
          };
  }

  private static persistSession(session: FaroUserSession): void {
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

  checkSession(activity: SessionActivityKind, currentSession?: FaroUserSession | null): FaroUserSession {
    return this.updateUserSession(activity, currentSession);
  }

  resetSession(): FaroUserSession {
    if (this.activityWriteTimer != null) {
      clearTimeout(this.activityWriteTimer);
      this.activityWriteTimer = null;
    }
    this.hasPendingActivityWrite = false;

    const session = this.resetUserSession();
    this.lastActivityWrite = dateNow();
    return session;
  }

  private flushActivityWrite = (): void => {
    if (this.activityWriteTimer != null) {
      clearTimeout(this.activityWriteTimer);
      this.activityWriteTimer = null;
    }

    if (!this.hasPendingActivityWrite) {
      return;
    }

    const session = MmkvPersistentSessionsManager.fetchUserSession();
    this.hasPendingActivityWrite = false;
    if (session == null) {
      return;
    }

    MmkvPersistentSessionsManager.persistSession(session);
    this.lastActivityWrite = dateNow();
  };

  private recordUserSessionActivity = (session: FaroUserSession): void => {
    // Keep expiry checks exact in memory while limiting native storage writes.
    MmkvPersistentSessionsManager.setRuntimeSession(session);
    this.hasPendingActivityWrite = true;

    const elapsed = dateNow() - this.lastActivityWrite;
    if (this.lastActivityWrite === 0 || elapsed < 0 || elapsed >= STORAGE_UPDATE_DELAY) {
      this.flushActivityWrite();
      return;
    }

    if (this.activityWriteTimer == null) {
      this.activityWriteTimer = setTimeout(this.flushActivityWrite, STORAGE_UPDATE_DELAY - elapsed);
    }
  };

  private handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (nextAppState === 'background') {
      this.wasBackgrounded = true;
      this.flushActivityWrite();
      return;
    }

    if (nextAppState === 'active' && this.wasBackgrounded) {
      this.wasBackgrounded = false;
      this.checkSession(SessionActivityKind.Meaningful);
    }
  };

  private init(): void {
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);

    const metaUpdateHandler = getSessionMetaUpdateHandler({
      fetchUserSession: MmkvPersistentSessionsManager.fetchUserSession,
      storeUserSession: MmkvPersistentSessionsManager.storeUserSession,
    });
    const registeredMetas = faro.metas;
    registeredMetas.addListener(metaUpdateHandler);
    this.metaUpdateHandler = metaUpdateHandler;
    this.registeredMetas = registeredMetas;
  }

  unpatch(): void {
    this.flushActivityWrite();

    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    const metaUpdateHandler = this.metaUpdateHandler;
    const registeredMetas = this.registeredMetas;
    this.metaUpdateHandler = null;
    this.registeredMetas = null;
    if (metaUpdateHandler && registeredMetas) {
      registeredMetas.removeListener(metaUpdateHandler);
    }
  }
}
