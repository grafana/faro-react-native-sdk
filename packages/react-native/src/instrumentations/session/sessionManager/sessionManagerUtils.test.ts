import * as faroCore from '@grafana/faro-core';
import { initializeFaro } from '@grafana/faro-core';
import { mockConfig } from '@grafana/faro-test-utils';

import * as samplingModule from './sampling';
import {
  addSessionMetadataToNextSession,
  createUserSessionObject,
  getSessionMetaUpdateHandler,
  getUserSessionUpdater,
  isUserSessionValid,
} from './sessionManagerUtils';
import type { FaroUserSession } from './types';

const fakeSystemTime = new Date('2023-01-01').getTime();
const mockSessionId = '123';
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_EXPIRATION_MS = 4 * 60 * 60 * 1000; // 4 hours

describe('sessionManagerUtils', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(fakeSystemTime);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('createUserSessionObject', () => {
    it('creates new user session object', () => {
      jest.spyOn(faroCore, 'genShortID').mockReturnValueOnce(mockSessionId);

      const newSession = createUserSessionObject();

      expect(newSession).toStrictEqual({
        sessionId: mockSessionId,
        lastActivity: fakeSystemTime,
        started: fakeSystemTime,
        isSampled: true,
      });
    });

    it('creates with given sessionId', () => {
      const mockInitialSessionId = 'abcde';
      const newSession = createUserSessionObject({ sessionId: mockInitialSessionId });

      expect(newSession).toStrictEqual({
        sessionId: mockInitialSessionId,
        lastActivity: fakeSystemTime,
        started: fakeSystemTime,
        isSampled: true,
      });
    });

    it('creates with custom started and lastActivity', () => {
      const customStarted = fakeSystemTime - 1000;
      const customLastActivity = fakeSystemTime - 500;

      const newSession = createUserSessionObject({
        started: customStarted,
        lastActivity: customLastActivity,
      });

      expect(newSession.started).toBe(customStarted);
      expect(newSession.lastActivity).toBe(customLastActivity);
    });

    it('creates with custom isSampled value', () => {
      const newSession = createUserSessionObject({ isSampled: false });
      expect(newSession.isSampled).toBe(false);
    });

    it('uses user defined generateSessionId', () => {
      const customGeneratedSessionId = 'my-custom-id';

      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          generateSessionId() {
            return customGeneratedSessionId;
          },
        },
      });

      initializeFaro(config);

      const newSession = createUserSessionObject();

      expect(newSession.sessionId).toBe(customGeneratedSessionId);
    });
  });

  describe('isUserSessionValid', () => {
    it('returns false if session is null', () => {
      const isValid = isUserSessionValid(null);
      expect(isValid).toBe(false);
    });

    it('returns false if activity timeout is reached', () => {
      const session = createUserSessionObject();
      session.lastActivity = fakeSystemTime - INACTIVITY_TIMEOUT_MS;

      const isValid = isUserSessionValid(session);
      expect(isValid).toBe(false);
    });

    it('returns false if lifetime timeout is reached', () => {
      const session = createUserSessionObject();
      session.started = fakeSystemTime - SESSION_EXPIRATION_MS;

      const isValid = isUserSessionValid(session);
      expect(isValid).toBe(false);
    });

    it('returns true for valid session', () => {
      const session = createUserSessionObject();
      const isValid = isUserSessionValid(session);
      expect(isValid).toBe(true);
    });

    it('returns true if activity timeout is not reached', () => {
      const session = createUserSessionObject();
      session.lastActivity = fakeSystemTime - INACTIVITY_TIMEOUT_MS + 1000;

      const isValid = isUserSessionValid(session);
      expect(isValid).toBe(true);
    });

    it('returns true if lifetime timeout is not reached', () => {
      const session = createUserSessionObject();
      session.started = fakeSystemTime - SESSION_EXPIRATION_MS + 1000;

      const isValid = isUserSessionValid(session);
      expect(isValid).toBe(true);
    });
  });

  describe('addSessionMetadataToNextSession', () => {
    it('adds metadata to session without previous session', () => {
      const config = mockConfig({});
      initializeFaro(config);

      const newSession: FaroUserSession = {
        lastActivity: 1,
        started: 2,
        sessionId: 'new-session-id',
        isSampled: true,
      };

      const sessionWithMetadata = addSessionMetadataToNextSession(newSession, null);

      expect(sessionWithMetadata).toStrictEqual({
        ...newSession,
        sessionMeta: {
          id: newSession.sessionId,
          attributes: {
            isSampled: 'true',
          },
        },
      });
    });

    it('adds previousSession attribute when previous session exists', () => {
      const config = mockConfig({});
      initializeFaro(config);

      const newSession: FaroUserSession = {
        lastActivity: 1,
        started: 2,
        sessionId: 'new-session-id',
        isSampled: true,
      };

      const previousSession: FaroUserSession = {
        lastActivity: 8,
        started: 9,
        sessionId: 'previous-session-id',
        isSampled: true,
      };

      const sessionWithMetadata = addSessionMetadataToNextSession(newSession, previousSession);

      expect(sessionWithMetadata).toStrictEqual({
        ...newSession,
        sessionMeta: {
          id: newSession.sessionId,
          attributes: {
            previousSession: previousSession.sessionId,
            isSampled: 'true',
          },
        },
      });
    });

    it('preserves existing session attributes from metas', () => {
      const config = mockConfig({});
      const { api } = initializeFaro(config);

      const newSession: FaroUserSession = {
        lastActivity: 1,
        started: 2,
        sessionId: 'new-session-id',
        isSampled: true,
      };

      const previousSession: FaroUserSession = {
        lastActivity: 8,
        started: 9,
        sessionId: 'previous-session-id',
        isSampled: true,
      };

      const sessionMeta = {
        id: previousSession.sessionId,
        attributes: {
          previousSession: '12345',
          foo: 'bar',
          baz: 'bam',
        },
      };

      api.setSession(sessionMeta);

      const sessionWithMetadata = addSessionMetadataToNextSession(newSession, previousSession);

      expect(sessionWithMetadata).toStrictEqual({
        ...newSession,
        sessionMeta: {
          id: newSession.sessionId,
          attributes: {
            ...sessionMeta.attributes,
            isSampled: 'true',
            previousSession: previousSession.sessionId,
          },
        },
      });
    });

    it('adds overrides from metas', () => {
      const config = mockConfig({});
      const { api } = initializeFaro(config);

      const newSession: FaroUserSession = {
        lastActivity: 1,
        started: 2,
        sessionId: 'new-session-id',
        isSampled: true,
      };

      const previousSession: FaroUserSession = {
        lastActivity: 8,
        started: 9,
        sessionId: 'previous-session-id',
        isSampled: true,
      };

      const overrides = {
        serviceName: 'my-service',
      };

      api.setSession(undefined, { overrides });

      const sessionWithOverrides = addSessionMetadataToNextSession(newSession, previousSession);

      expect(sessionWithOverrides).toStrictEqual({
        ...newSession,
        sessionMeta: {
          id: newSession.sessionId,
          overrides,
          attributes: {
            previousSession: previousSession.sessionId,
            isSampled: 'true',
          },
        },
      });
    });
  });

  describe('getUserSessionUpdater', () => {
    it('updates session when session is invalid', async () => {
      const mockOnSessionChange = jest.fn();
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          onSessionChange: mockOnSessionChange,
        },
      });

      const _faro = initializeFaro(config);

      const mockFetchUserSession = jest.fn().mockResolvedValue(null);
      const mockStoreUserSession = jest.fn().mockResolvedValue(undefined);

      const updateSession = getUserSessionUpdater({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });

      jest.spyOn(faroCore, 'genShortID').mockReturnValueOnce(mockSessionId);
      jest.spyOn(samplingModule, 'isSampled').mockReturnValueOnce(true);

      await updateSession();

      expect(mockFetchUserSession).toHaveBeenCalledTimes(1);
      expect(mockStoreUserSession).toHaveBeenCalledTimes(1);
      expect(mockOnSessionChange).toHaveBeenCalledTimes(1);
    });

    it('refreshes lastActivity for an existing valid session', async () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
        },
      });

      initializeFaro(config);

      const existingSession: FaroUserSession = {
        sessionId: mockSessionId,
        started: fakeSystemTime,
        lastActivity: fakeSystemTime - 1000,
        isSampled: true,
      };

      const mockFetchUserSession = jest.fn().mockResolvedValue(existingSession);
      const mockStoreUserSession = jest.fn().mockResolvedValue(undefined);

      const updateSession = getUserSessionUpdater({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });

      await updateSession();

      expect(mockStoreUserSession).toHaveBeenCalledWith({
        ...existingSession,
        lastActivity: fakeSystemTime,
      });
    });
  });

  describe('getSessionMetaUpdateHandler', () => {
    it('creates new session when session ID changes', async () => {
      initializeFaro(mockConfig({}));

      const mockFetchUserSession = jest.fn().mockResolvedValue(null);
      const mockStoreUserSession = jest.fn().mockResolvedValue(undefined);

      const handler = getSessionMetaUpdateHandler({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });

      jest.spyOn(samplingModule, 'isSampled').mockReturnValueOnce(true);

      const newSessionId = 'new-session-id';
      await handler({
        session: {
          id: newSessionId,
        },
      });

      expect(mockStoreUserSession).toHaveBeenCalledTimes(1);
      expect(mockStoreUserSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: newSessionId,
        })
      );
    });

    it('updates attributes without creating new session', async () => {
      const faro = initializeFaro(mockConfig({}));

      const storedSession: FaroUserSession = {
        sessionId: mockSessionId,
        isSampled: true,
        lastActivity: fakeSystemTime,
        started: fakeSystemTime,
        sessionMeta: {
          id: mockSessionId,
          attributes: {
            isSampled: 'true',
          },
        },
      };

      const mockFetchUserSession = jest.fn().mockResolvedValue(storedSession);
      const mockStoreUserSession = jest.fn().mockResolvedValue(undefined);

      const handler = getSessionMetaUpdateHandler({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });

      faro.api.setSession({
        id: mockSessionId,
        attributes: {
          isSampled: 'true',
          foo: 'bar',
        },
      });

      await handler(faro.metas.value);

      expect(mockStoreUserSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: mockSessionId,
          sessionMeta: expect.objectContaining({
            attributes: expect.objectContaining({
              foo: 'bar',
            }),
          }),
        })
      );
    });

    it('sends service name override event when service name changes', async () => {
      const faro = initializeFaro(
        mockConfig({
          app: {
            name: 'my-app',
            version: '1.0.0',
          },
        })
      );

      const mockFetchUserSession = jest.fn().mockResolvedValue(null);
      const mockStoreUserSession = jest.fn().mockResolvedValue(undefined);

      const handler = getSessionMetaUpdateHandler({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });

      const mockPushEvent = jest.fn();
      jest.spyOn(faro.api, 'pushEvent').mockImplementation(mockPushEvent);

      const newOverrides = { serviceName: 'my-service' };

      await handler({
        session: {
          id: mockSessionId,
          overrides: newOverrides,
        },
      });

      expect(mockPushEvent).toHaveBeenCalledWith('service_name_override', {
        serviceName: 'my-service',
        previousServiceName: 'my-app',
      });
    });

    it('settles after applying its own update and still accepts later external changes', async () => {
      const faro = initializeFaro(mockConfig({}));

      jest.spyOn(samplingModule, 'isSampled').mockReturnValue(true);

      // Storage that returns what was last written, but with a device value that
      // changes on every read - mirroring the volatile device attributes on React
      // Native. The stored snapshot therefore never compares equal to the incoming
      // meta, so nothing but the guard can stop the handler from re-entering
      // itself after its own `setSession()` call.
      let storedSession: FaroUserSession | null = null;
      let deviceMemoryReads = 0;
      const mockStoreUserSession = jest.fn(async (session: FaroUserSession) => {
        storedSession = session;
      });
      const mockFetchUserSession = jest.fn(async () =>
        storedSession == null
          ? null
          : {
              ...storedSession,
              sessionMeta: {
                ...storedSession.sessionMeta,
                id: storedSession.sessionId,
                attributes: {
                  ...storedSession.sessionMeta?.attributes,
                  device_memory_used: `${++deviceMemoryReads}`,
                },
              },
            }
      );

      // Stop propagating session updates past a sane number of calls. Without the
      // guard the handler re-enters itself forever, which would exhaust the heap
      // instead of failing on the assertions below.
      const MAX_SET_SESSION_CALLS = 10;
      const setSession = faro.api.setSession.bind(faro.api);
      const setSessionSpy = jest.spyOn(faro.api, 'setSession').mockImplementation((...args) => {
        if (setSessionSpy.mock.calls.length <= MAX_SET_SESSION_CALLS) {
          setSession(...args);
        }
      });

      const handler = getSessionMetaUpdateHandler({
        fetchUserSession: mockFetchUserSession,
        storeUserSession: mockStoreUserSession,
      });
      faro.metas.addListener(handler);

      // The handler applies the change once; the `setSession()` it performs itself
      // must not be picked up as another external change.
      await handler({ session: { id: mockSessionId, attributes: { isSampled: 'true' } } });
      await Promise.resolve();

      expect(mockStoreUserSession).toHaveBeenCalledTimes(1);

      // A genuinely external change afterwards is still synced, so the guard did
      // not leave the handler permanently disabled.
      const writesBeforeExternalChange = mockStoreUserSession.mock.calls.length;
      const nextSessionId = 'next-session-id';

      faro.api.setSession({ id: nextSessionId });
      await Promise.resolve();

      expect(mockStoreUserSession.mock.calls.length).toBeGreaterThan(writesBeforeExternalChange);
      expect(mockStoreUserSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: nextSessionId }));
    });
  });
});
