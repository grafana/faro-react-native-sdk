import type { FaroUserSession } from './types';

export const PERSISTED_SESSION_SCHEMA_VERSION = 1;

type PersistedSessionRecord = {
  schemaVersion: typeof PERSISTED_SESSION_SCHEMA_VERSION;
  currentSessionId: string;
  previousSessionId: string | null;
  startedAt: number;
  lastActivityAt: number;
  isSampled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function serializePersistentSession(session: FaroUserSession): string {
  const previousSession = session.sessionMeta?.attributes?.['previousSession'];
  const record: PersistedSessionRecord = {
    schemaVersion: PERSISTED_SESSION_SCHEMA_VERSION,
    currentSessionId: session.sessionId,
    previousSessionId: isNonEmptyString(previousSession) ? previousSession : null,
    startedAt: session.started,
    // Preserve the record invariant if the device clock moves backwards after
    // the session starts.
    lastActivityAt: Math.max(session.started, session.lastActivity),
    isSampled: session.isSampled,
  };

  return JSON.stringify(record);
}

export function parsePersistentSession(serialized: string): FaroUserSession | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }

  if (
    !isRecord(value) ||
    value['schemaVersion'] !== PERSISTED_SESSION_SCHEMA_VERSION ||
    !isNonEmptyString(value['currentSessionId']) ||
    !(value['previousSessionId'] === null || isNonEmptyString(value['previousSessionId'])) ||
    !isValidTimestamp(value['startedAt']) ||
    !isValidTimestamp(value['lastActivityAt']) ||
    value['lastActivityAt'] < value['startedAt'] ||
    typeof value['isSampled'] !== 'boolean'
  ) {
    return null;
  }

  const previousSessionId = value['previousSessionId'];

  return {
    sessionId: value['currentSessionId'],
    started: value['startedAt'],
    lastActivity: value['lastActivityAt'],
    isSampled: value['isSampled'],
    sessionMeta: {
      id: value['currentSessionId'],
      attributes: {
        isSampled: value['isSampled'].toString(),
        ...(previousSessionId == null ? {} : { previousSession: previousSessionId }),
      },
    },
  };
}
