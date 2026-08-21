import { NativeModules } from 'react-native';

export const MAIN_PROCESS_SESSION_STORAGE_ID = 'grafana-faro-react-native-session';

interface SessionProcessNativeModule {
  claimSessionPersistence?: () => unknown;
  getSessionProcessIdentifier?: () => unknown;
  isMainSessionProcess?: () => unknown;
  releaseSessionPersistence?: () => unknown;
}

export interface SessionProcessInfo {
  identifier: string;
  isMain: boolean;
}

let cachedProcessInfo: SessionProcessInfo | null | undefined;
let cachedPersistenceOwnership: boolean | undefined;

function getNativeModule(): SessionProcessNativeModule | undefined {
  return NativeModules['FaroReactNativeModule'] as SessionProcessNativeModule | undefined;
}

/** Stable native process identity used to isolate session chains. */
export function getSessionProcessInfo(): SessionProcessInfo | null {
  if (cachedProcessInfo !== undefined) {
    return cachedProcessInfo;
  }

  const nativeModule = getNativeModule();
  if (
    typeof nativeModule?.getSessionProcessIdentifier !== 'function' ||
    typeof nativeModule.isMainSessionProcess !== 'function'
  ) {
    cachedProcessInfo = null;
    return cachedProcessInfo;
  }

  try {
    const identifier = nativeModule.getSessionProcessIdentifier();
    const isMain = nativeModule.isMainSessionProcess();
    if (typeof identifier !== 'string' || identifier.trim().length === 0 || typeof isMain !== 'boolean') {
      cachedProcessInfo = null;
      return cachedProcessInfo;
    }

    cachedProcessInfo = { identifier: identifier.trim(), isMain };
  } catch {
    cachedProcessInfo = null;
  }

  return cachedProcessInfo;
}

/**
 * Returns the MMKV instance ID owned by this runtime, or null when exclusive
 * ownership cannot be established. The main process retains the legacy ID so
 * upgrades keep their existing previous-session link.
 */
export function claimSessionPersistenceStorageId(): string | null {
  const processInfo = getSessionProcessInfo();
  if (processInfo == null) {
    return null;
  }

  if (cachedPersistenceOwnership === undefined) {
    const nativeModule = getNativeModule();
    if (typeof nativeModule?.claimSessionPersistence !== 'function') {
      cachedPersistenceOwnership = false;
    } else {
      try {
        cachedPersistenceOwnership = nativeModule.claimSessionPersistence() === true;
      } catch {
        cachedPersistenceOwnership = false;
      }
    }
  }

  if (!cachedPersistenceOwnership) {
    return null;
  }

  return processInfo.isMain
    ? MAIN_PROCESS_SESSION_STORAGE_ID
    : `${MAIN_PROCESS_SESSION_STORAGE_ID}.${encodeURIComponent(processInfo.identifier)}`;
}

/** Releases storage ownership after MMKV initialization fails. */
export function releaseSessionPersistenceOwnership(): boolean {
  if (cachedPersistenceOwnership !== true) {
    return false;
  }

  const nativeModule = getNativeModule();
  if (typeof nativeModule?.releaseSessionPersistence !== 'function') {
    return false;
  }

  try {
    const released = nativeModule.releaseSessionPersistence() === true;
    if (released) {
      cachedPersistenceOwnership = undefined;
    }
    return released;
  } catch {
    return false;
  }
}

/** @internal */
export function resetSessionProcessForTests(): void {
  cachedProcessInfo = undefined;
  cachedPersistenceOwnership = undefined;
}
