import { EVENT_SESSION_START, initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SessionInstrumentation } from './index';
import { MmkvPersistentSessionsManager } from './sessionManager/MmkvPersistentSessionsManager';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

async function initializeWithoutInstrumentations() {
  return initializeFaro(
    mockConfig({
      instrumentations: [],
      transports: [new MockTransport()],
      url: 'http://localhost:12345/collect',
      sessionTracking: { enabled: true, persistent: false },
    })
  );
}

function sessionStartCount(transport: MockTransport): number {
  return transport.items.filter(
    (item) => item.type === TransportItemType.EVENT && item.payload.name === EVENT_SESSION_START
  ).length;
}

function sessionItem(isSampled: boolean): TransportItem {
  return {
    type: TransportItemType.EVENT,
    payload: { name: 'test' },
    meta: {
      session: {
        id: 'active-session',
        attributes: { isSampled: isSampled.toString() },
      },
    },
  };
}

function expectSampledItem(result: TransportItem | null): TransportItem {
  expect(result).not.toBeNull();
  if (result == null) {
    throw new Error('Expected a sampled item to be retained.');
  }

  expect(result.payload).toEqual({ name: 'test' });
  expect(result.meta.session?.attributes?.['isSampled']).toBeUndefined();
  return result;
}

describe('session cleanup', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    VolatileSessionsManager.removeUserSession();
  });

  afterEach(() => {
    VolatileSessionsManager.removeUserSession();
  });

  it('removes the volatile manager metas listener with the same handler', async () => {
    const faro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(faro.metas, 'addListener');
    const removeListenerSpy = jest.spyOn(faro.metas, 'removeListener');
    const storeSessionSpy = jest.spyOn(VolatileSessionsManager, 'storeUserSession');
    const manager = new VolatileSessionsManager();
    const handler = addListenerSpy.mock.calls[0]?.[0];

    expect(handler).toBeDefined();
    faro.api.setSession({ id: 'before-cleanup' });
    expect(storeSessionSpy).toHaveBeenCalled();
    storeSessionSpy.mockClear();

    manager.unpatch();
    manager.unpatch();

    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalledWith(handler);

    faro.api.setSession({ id: 'after-cleanup' });
    expect(storeSessionSpy).not.toHaveBeenCalled();
  });

  it('removes the persistent manager metas listener with the same handler', async () => {
    const faro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(faro.metas, 'addListener');
    const removeListenerSpy = jest.spyOn(faro.metas, 'removeListener');
    jest.spyOn(MmkvPersistentSessionsManager, 'fetchUserSession').mockReturnValue(null);
    const storeSessionSpy = jest.spyOn(MmkvPersistentSessionsManager, 'storeUserSession').mockImplementation();
    const manager = new MmkvPersistentSessionsManager();
    const handler = addListenerSpy.mock.calls[0]?.[0];

    expect(handler).toBeDefined();
    faro.api.setSession({ id: 'before-cleanup' });
    expect(storeSessionSpy).toHaveBeenCalled();
    storeSessionSpy.mockClear();

    manager.unpatch();
    manager.unpatch();

    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalledWith(handler);

    faro.api.setSession({ id: 'after-cleanup' });
    expect(storeSessionSpy).not.toHaveBeenCalled();
  });

  it('cleans up through destroy while a retained hook still enforces sampling', async () => {
    const transport = new MockTransport();
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [transport],
        url: 'http://localhost:12345/collect',
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const addListenerSpy = jest.spyOn(faro.metas, 'addListener');
    const removeListenerSpy = jest.spyOn(faro.metas, 'removeListener');
    const removeBeforeSendHooksSpy = jest.spyOn(faro.transports, 'removeBeforeSendHooks');
    const instrumentation = new SessionInstrumentation();

    faro.instrumentations.add(instrumentation);

    const registeredListeners = addListenerSpy.mock.calls.map(([listener]) => listener);
    expect(registeredListeners).toHaveLength(2);

    const beforeSendHooks = faro.transports.getBeforeSendHooks();
    expect(beforeSendHooks).toHaveLength(1);
    const beforeSendHook = beforeSendHooks[0];
    if (beforeSendHook == null) {
      throw new Error('Expected the session before-send hook to be registered.');
    }
    expectSampledItem(beforeSendHook(sessionItem(true)));

    const sessionStartsBeforeDestroy = sessionStartCount(transport);
    instrumentation.destroy();

    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(new Set(removeListenerSpy.mock.calls.map(([listener]) => listener))).toStrictEqual(
      new Set(registeredListeners)
    );
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledWith(beforeSendHook);
    // A detached session hook must not rotate sessions, but older Faro Core
    // versions can retain it, so the captured hook still owns sampling cleanup.
    expect(beforeSendHook(sessionItem(false))).toBeNull();
    expectSampledItem(beforeSendHook(sessionItem(true)));

    faro.api.setSession({ id: 'after-cleanup' });
    expect(sessionStartCount(transport)).toBe(sessionStartsBeforeDestroy);

    instrumentation.destroy();
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('binds a manager listener to the supplied metas instance', async () => {
    const registeredFaro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(registeredFaro.metas, 'addListener');
    const removeRegisteredListenerSpy = jest.spyOn(registeredFaro.metas, 'removeListener');
    const replacementFaro = await initializeWithoutInstrumentations();
    const addReplacementListenerSpy = jest.spyOn(replacementFaro.metas, 'addListener');
    const removeReplacementListenerSpy = jest.spyOn(replacementFaro.metas, 'removeListener');
    const manager = new VolatileSessionsManager(registeredFaro.metas);
    const handler = addListenerSpy.mock.calls[0]?.[0];

    manager.unpatch();

    expect(addListenerSpy).toHaveBeenCalledWith(handler);
    expect(addReplacementListenerSpy).not.toHaveBeenCalled();
    expect(removeRegisteredListenerSpy).toHaveBeenCalledWith(handler);
    expect(removeReplacementListenerSpy).not.toHaveBeenCalled();
  });

  it('moves every registration when an instrumentation instance is reused', async () => {
    const instrumentation = new SessionInstrumentation();
    const firstTransport = new MockTransport();
    const firstFaro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [firstTransport],
        url: 'http://localhost:12345/collect',
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const firstRemoveListenerSpy = jest.spyOn(firstFaro.metas, 'removeListener');
    firstFaro.instrumentations.add(instrumentation);
    const firstHook = firstFaro.transports.getBeforeSendHooks()[0];
    if (firstHook == null) {
      throw new Error('Expected the first Faro instance to retain its session hook.');
    }

    const secondTransport = new MockTransport();
    const secondFaro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [secondTransport],
        url: 'http://localhost:12345/collect',
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const secondAddListenerSpy = jest.spyOn(secondFaro.metas, 'addListener');
    const secondRemoveListenerSpy = jest.spyOn(secondFaro.metas, 'removeListener');
    secondFaro.instrumentations.add(instrumentation);

    expect(firstRemoveListenerSpy).toHaveBeenCalledTimes(2);
    expect(secondAddListenerSpy).toHaveBeenCalledTimes(2);
    const firstHookResult = expectSampledItem(firstHook(sessionItem(true)));
    expect(firstHookResult.meta.session?.id).toBe('active-session');

    const secondSessionStarts = sessionStartCount(secondTransport);
    firstFaro.api.setSession({ id: 'stale-faro-session' });
    expect(sessionStartCount(secondTransport)).toBe(secondSessionStarts);

    secondFaro.api.setSession({ id: 'active-faro-session' });
    expect(sessionStartCount(secondTransport)).toBe(secondSessionStarts + 1);

    instrumentation.destroy();
    expect(secondRemoveListenerSpy).toHaveBeenCalledTimes(2);

    secondFaro.api.setSession({ id: 'after-destroy' });
    expect(sessionStartCount(secondTransport)).toBe(secondSessionStarts + 1);
  });

  it('lets a replacement hook reattribute items retained by an older Faro Core', async () => {
    const faro = await initializeWithoutInstrumentations();
    const firstInstrumentation = new SessionInstrumentation();
    faro.instrumentations.add(firstInstrumentation);
    faro.instrumentations.remove(firstInstrumentation);

    const replacementInstrumentation = new SessionInstrumentation();
    faro.instrumentations.add(replacementInstrumentation);

    const activeSession = VolatileSessionsManager.fetchUserSession();
    if (activeSession == null) {
      throw new Error('Expected the replacement instrumentation to own a session.');
    }

    const result = faro.transports
      .getBeforeSendHooks()
      .reduce<TransportItem | null>((item, hook) => (item == null ? null : hook(item)), sessionItem(false));
    const sampledResult = expectSampledItem(result);

    expect(sampledResult.meta.session?.id).toBe(activeSession.sessionId);
    replacementInstrumentation.destroy();
  });
});
