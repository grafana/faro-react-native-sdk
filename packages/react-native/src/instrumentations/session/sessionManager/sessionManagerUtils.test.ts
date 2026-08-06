import * as faroCore from '@grafana/faro-core';
import { initializeFaro, stringifyExternalJson } from '@grafana/faro-core';
import type { Faro, MetaAttributes } from '@grafana/faro-core';
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

    // The handlers are async and timers are faked, so they settle on the
    // microtask queue alone. A generous number of turns outlasts every
    // echo-notification chain before the assertions run.
    async function flushMicrotasks(turns = 20): Promise<void> {
      for (let i = 0; i < turns; i++) {
        await Promise.resolve();
      }
    }

    // Round-trips sessions through the same lossy serialization persistent
    // storage uses: `stringifyExternalJson` drops keys whose value is
    // `undefined`.
    function createJsonBackedSessionStorage() {
      let stored: string | null = null;

      return {
        storeUserSession: jest.fn(async (session: FaroUserSession) => {
          stored = stringifyExternalJson(session);
        }),
        fetchUserSession: jest.fn(
          async (): Promise<FaroUserSession | null> => (stored == null ? null : JSON.parse(stored))
        ),
      };
    }

    describe('settling', () => {
      let faro: Faro;
      let storage: ReturnType<typeof createJsonBackedSessionStorage>;
      let handlers: Array<ReturnType<typeof getSessionMetaUpdateHandler>>;

      function attachHandler(): void {
        const handler = getSessionMetaUpdateHandler(storage);
        faro.metas.addListener(handler);
        handlers.push(handler);
      }

      beforeEach(() => {
        faro = initializeFaro(mockConfig({}));
        jest.spyOn(samplingModule, 'isSampled').mockReturnValue(true);
        storage = createJsonBackedSessionStorage();
        handlers = [];

        // Stop propagating session updates past a sane number of calls, so a
        // regression that reintroduces the sync loop fails on the write-count
        // assertions below instead of exhausting the heap.
        const setSession = faro.api.setSession.bind(faro.api);
        const setSessionSpy = jest.spyOn(faro.api, 'setSession').mockImplementation((...args) => {
          if (setSessionSpy.mock.calls.length <= 10) {
            setSession(...args);
          }
        });
      });

      afterEach(() => {
        handlers.forEach((handler) => faro.metas.removeListener(handler));
      });

      it('settles after applying its own update and still accepts later external changes', async () => {
        attachHandler();

        // The handler applies the external change once; the `setSession()` it
        // performs itself must not be picked up as another external change.
        faro.api.setSession({ id: mockSessionId });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(1);

        // A genuinely external change afterwards is still synced, so the guard
        // did not leave the handler permanently disabled.
        faro.api.setSession({ id: 'next-session-id' });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(2);
        expect(storage.storeUserSession).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'next-session-id' })
        );
      });

      it('does not write the session again when an unrelated meta changes', async () => {
        attachHandler();

        // An attribute whose value is `undefined` mirrors the optional device
        // attributes (battery level, carrier, ...). Storage drops the key on
        // write; the in-memory meta must converge to the same shape.
        faro.api.setSession({
          id: mockSessionId,
          attributes: { device_battery_level: undefined } as unknown as MetaAttributes,
        });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(1);

        // Unrelated meta updates notify the handler with an unchanged session;
        // none of them may write the session again.
        faro.api.setView({ name: 'first-view' });
        await flushMicrotasks();
        faro.api.setUser({ id: 'user-1' });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(1);
      });

      it('does not rewrite the session when overrides carry an undefined value', async () => {
        attachHandler();

        // Overrides diverge from their own stored copy exactly like attributes
        // do: the `undefined`-valued key survives in memory but not in storage.
        faro.api.setSession({
          id: mockSessionId,
          overrides: { serviceName: 'my-service', geoLocationTrackingEnabled: undefined },
        });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(1);

        faro.api.setView({ name: 'first-view' });
        await flushMicrotasks();

        expect(storage.storeUserSession).toHaveBeenCalledTimes(1);
      });

      it('settles when more than one handler is registered', async () => {
        // More than one handler can be registered over the same storage. They
        // must not re-trigger one another through the echo notifications of
        // their own writes.
        attachHandler();
        attachHandler();

        faro.api.setSession({
          id: mockSessionId,
          attributes: { device_battery_level: undefined } as unknown as MetaAttributes,
        });
        await flushMicrotasks();

        // Both handlers may process the original notification, but the writes
        // must settle instead of ping-ponging.
        const writesAfterSettling = storage.storeUserSession.mock.calls.length;
        expect(writesAfterSettling).toBeLessThanOrEqual(2);

        // ...and a later unrelated meta change must not start writing again.
        faro.api.setView({ name: 'first-view' });
        await flushMicrotasks();

        expect(storage.storeUserSession.mock.calls.length).toBe(writesAfterSettling);
      });
    });
  });
});
