import {
  dateNow,
  deepEqual,
  EVENT_OVERRIDES_SERVICE_NAME,
  faro,
  genShortID,
  isEmpty,
  stringifyExternalJson,
} from '@grafana/faro-core';
import type { Meta, MetaOverrides, MetaSession } from '@grafana/faro-core';

import { SessionActivityKind } from '../sessionActivity';

import { isSampled } from './sampling';
import { MAX_SESSION_PERSISTENCE_TIME } from './sessionConstants';
import type { FaroUserSession } from './types';

const DEFAULT_SESSION_EXPIRATION_MS = 4 * 60 * 60 * 1000; // 4 hours (not in faro-core)

function getSessionTimeouts(): {
  sessionExpirationTime: number;
  inactivityTimeout: number;
} {
  const inactivityTimeout = faro.config?.sessionTracking?.maxSessionPersistenceTime ?? MAX_SESSION_PERSISTENCE_TIME;
  return {
    sessionExpirationTime: DEFAULT_SESSION_EXPIRATION_MS,
    inactivityTimeout,
  };
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

  const { sessionExpirationTime, inactivityTimeout } = getSessionTimeouts();
  const now = dateNow();
  if (session.started > now || session.lastActivity > now) {
    return false;
  }

  const lifetimeValid = now - session.started < sessionExpirationTime;

  if (!lifetimeValid) {
    return false;
  }

  // The session expires at the boundary, matching cold-start record cleanup.
  const inactivityPeriodValid = now - session.lastActivity < inactivityTimeout;
  return inactivityPeriodValid;
}

type GetUserSessionUpdaterParams = {
  storeUserSession: (session: FaroUserSession) => void;
  fetchUserSession: () => FaroUserSession | null;
  recordUserSessionActivity?: (session: FaroUserSession) => void;
};

export function getUserSessionUpdater({
  fetchUserSession,
  recordUserSessionActivity,
  storeUserSession,
}: GetUserSessionUpdaterParams): (activity: SessionActivityKind) => FaroUserSession | null {
  const persistActivity = recordUserSessionActivity ?? storeUserSession;

  return function updateSession(activity: SessionActivityKind): FaroUserSession | null {
    const sessionFromStorage = fetchUserSession();

    if (sessionFromStorage != null && isUserSessionValid(sessionFromStorage)) {
      if (activity === SessionActivityKind.Meaningful) {
        const lastActivity = dateNow();
        if (lastActivity === sessionFromStorage.lastActivity) {
          return sessionFromStorage;
        }

        const refreshedSession = { ...sessionFromStorage, lastActivity };
        persistActivity(refreshedSession);
        return refreshedSession;
      }

      return sessionFromStorage;
    }

    const newSession = addSessionMetadataToNextSession(
      createUserSessionObject({ isSampled: isSampled() }),
      sessionFromStorage
    );

    storeUserSession(newSession);
    faro.api?.setSession(newSession.sessionMeta);

    const newSessionMeta = newSession.sessionMeta;
    if (newSessionMeta != null) {
      try {
        faro.config.sessionTracking?.onSessionChange?.(sessionFromStorage?.sessionMeta ?? null, newSessionMeta);
      } catch (error) {
        faro.unpatchedConsole?.warn?.('The session change callback failed:', error);
      }
    }

    return newSession;
  };
}

/**
 * Persistent storage serializes sessions with `stringifyExternalJson`, which
 * drops keys whose value is `undefined`. A session meta carrying such a key
 * never compares `deepEqual` to its own stored copy, so the sync handler would
 * rewrite the session on every meta notification. Applying the same round-trip
 * in memory keeps the two sides comparable, for attributes and overrides alike.
 */
export function toStorableSessionMeta(sessionMeta: MetaSession): MetaSession {
  return JSON.parse(stringifyExternalJson(sessionMeta)) as MetaSession;
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
  if (previousSessionId != null && previousSessionId !== newSession.sessionId) {
    sessionWithMeta.sessionMeta.attributes!['previousSession'] = previousSessionId;
  }

  // Normalize to what storage can hold, so the meta this session propagates
  // stays comparable to its own stored copy.
  sessionWithMeta.sessionMeta = toStorableSessionMeta(sessionWithMeta.sessionMeta);

  return sessionWithMeta;
}

type GetUserSessionMetaUpdateHandlerParams = {
  storeUserSession: (session: FaroUserSession) => void;
  fetchUserSession: () => FaroUserSession | null;
};

/**
 * Set only while a handler applies its own session update.
 *
 * `setSession()` notifies meta listeners synchronously, so a handler is
 * re-entered by its own write. This flag rejects that re-entry, and bounds any
 * future divergence between the in-memory and the stored session to a single
 * redundant write instead of an unbounded loop.
 *
 * Module scoped rather than per handler: more than one handler can be
 * registered over the same storage, and per-handler flags would let them
 * re-trigger one another through the echo notifications of their own writes.
 */
let isApplyingOwnUpdate = false;

export function getSessionMetaUpdateHandler({
  fetchUserSession,
  storeUserSession,
}: GetUserSessionMetaUpdateHandlerParams) {
  return function syncSessionIfChangedExternally(meta: Meta): void {
    // Checked before work begins so the synchronous re-entry triggered by
    // `setSession()` below is rejected while the flag is still set.
    if (isApplyingOwnUpdate) {
      return;
    }

    // Compare in storable form, so keys that storage cannot hold do not read
    // as a perpetual external change.
    const session = meta.session && toStorableSessionMeta(meta.session);
    const sessionFromSessionStorage = fetchUserSession();

    let sessionId = session?.id;
    const sessionAttributes = session?.attributes;
    const sessionOverrides = session?.overrides;

    const storedSessionMeta = sessionFromSessionStorage?.sessionMeta;
    const storedSessionMetaOverrides = storedSessionMeta?.overrides;

    const hasSessionOverridesChanged =
      sessionOverrides != null && !deepEqual(sessionOverrides, storedSessionMetaOverrides);
    const hasSessionMetaChanged =
      session != null &&
      (!deepEqual(sessionAttributes, storedSessionMeta?.attributes) ||
        !deepEqual(sessionOverrides, storedSessionMetaOverrides));
    const hasSessionIdChanged = !!session && sessionId !== sessionFromSessionStorage?.sessionId;

    if (hasSessionIdChanged || hasSessionMetaChanged) {
      const storedPreviousSessionId = storedSessionMeta?.attributes?.['previousSession'];
      const effectiveOverrides = sessionOverrides ?? storedSessionMetaOverrides;
      const userSession =
        sessionFromSessionStorage != null && !hasSessionIdChanged
          ? {
              ...sessionFromSessionStorage,
              sessionMeta: toStorableSessionMeta({
                id: sessionFromSessionStorage.sessionId,
                attributes: {
                  ...faro.config.sessionTracking?.session?.attributes,
                  ...(sessionAttributes ?? storedSessionMeta?.attributes),
                  ...(storedPreviousSessionId == null ? {} : { previousSession: storedPreviousSessionId }),
                  isSampled: sessionFromSessionStorage.isSampled.toString(),
                },
                ...(isEmpty(effectiveOverrides) ? {} : { overrides: effectiveOverrides }),
              }),
            }
          : addSessionMetadataToNextSession(
              createUserSessionObject({ sessionId, isSampled: isSampled() }),
              sessionFromSessionStorage
            );

      storeUserSession(userSession);
      sendOverrideEvent(hasSessionOverridesChanged, sessionOverrides, storedSessionMetaOverrides);

      isApplyingOwnUpdate = true;
      try {
        faro.api.setSession(userSession.sessionMeta);
      } finally {
        isApplyingOwnUpdate = false;
      }
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
