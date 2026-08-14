import {
  parsePersistentSession,
  PERSISTED_SESSION_SCHEMA_VERSION,
  serializePersistentSession,
} from './persistentSessionRecord';
import type { FaroUserSession } from './types';

const session: FaroUserSession = {
  sessionId: 'current-session',
  started: 100,
  lastActivity: 200,
  isSampled: false,
  sessionMeta: {
    id: 'current-session',
    attributes: {
      previousSession: 'previous-session',
      device_model: 'Test Phone',
      custom: 'not-persisted',
    },
    overrides: {
      serviceName: 'not-persisted',
    },
  },
};

describe('persistentSessionRecord', () => {
  it('serializes only the versioned minimal session state', () => {
    expect(JSON.parse(serializePersistentSession(session))).toStrictEqual({
      schemaVersion: PERSISTED_SESSION_SCHEMA_VERSION,
      currentSessionId: 'current-session',
      previousSessionId: 'previous-session',
      startedAt: 100,
      lastActivityAt: 200,
      isSampled: false,
    });
  });

  it('round-trips the fields needed for session continuity', () => {
    expect(parsePersistentSession(serializePersistentSession(session))).toStrictEqual({
      sessionId: 'current-session',
      started: 100,
      lastActivity: 200,
      isSampled: false,
      sessionMeta: {
        id: 'current-session',
        attributes: {
          isSampled: 'false',
          previousSession: 'previous-session',
        },
      },
    });
  });

  it.each([
    ['missing state', ''],
    ['corrupt JSON', '{not-json'],
    [
      'an unsupported schema',
      JSON.stringify({
        schemaVersion: PERSISTED_SESSION_SCHEMA_VERSION + 1,
        currentSessionId: 'current-session',
        previousSessionId: null,
        startedAt: 100,
        lastActivityAt: 200,
        isSampled: true,
      }),
    ],
    [
      'an unversioned legacy record',
      JSON.stringify({
        sessionId: 'legacy-session',
        started: 100,
        lastActivity: 200,
        isSampled: true,
      }),
    ],
    [
      'invalid timing',
      JSON.stringify({
        schemaVersion: PERSISTED_SESSION_SCHEMA_VERSION,
        currentSessionId: 'current-session',
        previousSessionId: null,
        startedAt: 200,
        lastActivityAt: 100,
        isSampled: true,
      }),
    ],
  ])('rejects %s', (_name, serialized) => {
    expect(parsePersistentSession(serialized)).toBeNull();
  });

  it('clamps a backward activity timestamp when serializing', () => {
    expect(
      JSON.parse(
        serializePersistentSession({
          ...session,
          started: 200,
          lastActivity: 100,
        })
      )
    ).toMatchObject({ startedAt: 200, lastActivityAt: 200 });
  });
});
