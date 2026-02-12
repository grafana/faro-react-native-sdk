import { dateNow, deepEqual, EVENT_OVERRIDES_SERVICE_NAME, faro, genShortID, isEmpty } from '@grafana/faro-core';
import type { Meta, MetaOverrides } from '@grafana/faro-core';
import { NativeModules } from 'react-native';

import { isSampled } from './sampling';
import { SESSION_EXPIRATION_TIME, SESSION_INACTIVITY_TIME } from './sessionConstants';
import type { FaroUserSession } from './types';

/**
 * Persist session ID to native storage for crash report correlation.
 *
 * When a crash occurs, the app terminates before the crash can be reported.
 * On the next app launch, we need to know which session was active when the crash
 * occurred so we can include it in the crash report context.
 *
 * This enables users to query events from the crashed session in Grafana,
 * even though the crash report is sent in a new session.
 *
 * Platform support:
 * - Android: Uses SharedPreferences
 * - iOS: Uses UserDefaults
 */
function persistSessionIdToNative(sessionId: string): void {
  try {
    const { FaroReactNativeModule } = NativeModules;
    if (FaroReactNativeModule?.persistSessionId) {
      FaroReactNativeModule.persistSessionId(sessionId);
    }
  } catch {
    // Silently fail - this is best-effort for crash correlation
    faro.unpatchedConsole?.debug?.('Failed to persist session ID to native storage');
  }
}

type CreateUserSessionObjectParams = {
  sessionId?: string;
  started?: number;
  lastActivity?: number;
  isSampled?: boolean;
};

export function createUserSessionObject({
  sessionId,
  started,
  lastActivity,
  isSampled: sampledValue = true,
}: CreateUserSessionObjectParams = {}): FaroUserSession {
  const now = dateNow();

  const generateSessionId = faro.config?.sessionTracking?.generateSessionId;

  if (sessionId == null) {
    sessionId = typeof generateSessionId === 'function' ? generateSessionId() : genShortID();
  }

  return {
    sessionId,
    lastActivity: lastActivity ?? now,
    started: started ?? now,
    isSampled: sampledValue,
  };
}

export function isUserSessionValid(session: FaroUserSession | null): boolean {
  if (session == null) {
    return false;
  }

  const now = dateNow();
  const lifetimeValid = now - session.started < SESSION_EXPIRATION_TIME;

  if (!lifetimeValid) {
    return false;
  }

  const inactivityPeriodValid = now - session.lastActivity < SESSION_INACTIVITY_TIME;
  return inactivityPeriodValid;
}

type GetUserSessionUpdaterParams = {
  storeUserSession: (session: FaroUserSession) => void | Promise<void>;
  fetchUserSession: () => FaroUserSession | null | Promise<FaroUserSession | null>;
};

type UpdateSessionParams = { forceSessionExtend: boolean };

export function getUserSessionUpdater({
  fetchUserSession,
  storeUserSession,
}: GetUserSessionUpdaterParams): (options?: UpdateSessionParams) => Promise<void> {
  return async function updateSession({ forceSessionExtend } = { forceSessionExtend: false }): Promise<void> {
    if (!fetchUserSession || !storeUserSession) {
      return;
    }

    const sessionFromStorage = await fetchUserSession();

    if (forceSessionExtend === false && isUserSessionValid(sessionFromStorage)) {
      await storeUserSession({ ...sessionFromStorage!, lastActivity: dateNow() });
    } else {
      let newSession = addSessionMetadataToNextSession(
        createUserSessionObject({ isSampled: isSampled() }),
        sessionFromStorage
      );

      await storeUserSession(newSession);

      faro.api?.setSession(newSession.sessionMeta);
      faro.config.sessionTracking?.onSessionChange?.(sessionFromStorage?.sessionMeta ?? null, newSession.sessionMeta!);
    }
  };
}

export function addSessionMetadataToNextSession(newSession: FaroUserSession, previousSession: FaroUserSession | null) {
  const sessionWithMeta: Required<FaroUserSession> = {
    ...newSession,
    sessionMeta: {
      id: newSession.sessionId,
      attributes: {
        ...faro.config.sessionTracking?.session?.attributes,
        ...(faro.metas.value.session?.attributes ?? {}),
        isSampled: newSession.isSampled.toString(),
      },
    },
  };

  const overrides = faro.metas.value.session?.overrides ?? previousSession?.sessionMeta?.overrides;
  if (!isEmpty(overrides)) {
    sessionWithMeta.sessionMeta.overrides = overrides;
  }

  const previousSessionId = previousSession?.sessionId;
  if (previousSessionId != null) {
    sessionWithMeta.sessionMeta.attributes!['previousSession'] = previousSessionId;
  }

  // Persist session ID to native storage for crash report correlation
  // Only persist when session ID actually changes (new session started)
  const isNewSession = newSession.sessionId !== previousSessionId;
  if (isNewSession) {
    persistSessionIdToNative(newSession.sessionId);
  }

  return sessionWithMeta;
}

type GetUserSessionMetaUpdateHandlerParams = {
  storeUserSession: (session: FaroUserSession) => void | Promise<void>;
  fetchUserSession: () => FaroUserSession | null | Promise<FaroUserSession | null>;
};

export function getSessionMetaUpdateHandler({
  fetchUserSession,
  storeUserSession,
}: GetUserSessionMetaUpdateHandlerParams) {
  return async function syncSessionIfChangedExternally(meta: Meta) {
    const session = meta.session;
    const sessionFromSessionStorage = await fetchUserSession();

    let sessionId = session?.id;
    const sessionAttributes = session?.attributes;
    const sessionOverrides = session?.overrides;

    const storedSessionMeta = sessionFromSessionStorage?.sessionMeta;
    const storedSessionMetaOverrides = storedSessionMeta?.overrides;

    const hasSessionOverridesChanged = !!sessionOverrides && !deepEqual(sessionOverrides, storedSessionMetaOverrides);
    const hasAttributesChanged = !!sessionAttributes && !deepEqual(sessionAttributes, storedSessionMeta?.attributes);
    const hasSessionIdChanged = !!session && sessionId !== sessionFromSessionStorage?.sessionId;

    if (hasSessionIdChanged || hasAttributesChanged || hasSessionOverridesChanged) {
      const userSession = addSessionMetadataToNextSession(
        createUserSessionObject({ sessionId, isSampled: isSampled() }),
        sessionFromSessionStorage
      );

      await storeUserSession(userSession);
      sendOverrideEvent(hasSessionOverridesChanged, sessionOverrides, storedSessionMetaOverrides);
      faro.api.setSession(userSession.sessionMeta);
    }
  };
}

function sendOverrideEvent(
  hasSessionOverridesChanged: boolean,
  sessionOverrides: MetaOverrides = {},
  storedSessionOverrides: MetaOverrides = {}
) {
  if (!hasSessionOverridesChanged) {
    return;
  }

  const serviceName = sessionOverrides.serviceName;
  const previousServiceName = storedSessionOverrides.serviceName ?? faro.metas.value.app?.name ?? '';

  if (serviceName && serviceName !== previousServiceName) {
    faro.api.pushEvent(EVENT_OVERRIDES_SERVICE_NAME, {
      serviceName,
      previousServiceName,
    });
  }
}
