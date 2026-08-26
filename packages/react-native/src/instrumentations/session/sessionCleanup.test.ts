import { EVENT_SESSION_START, EVENT_VIEW_CHANGED, initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { ViewInstrumentation } from '../view';

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
    expect(beforeSendHooks).toHaveLength(2);
    const [fallbackHook, beforeSendHook] = beforeSendHooks;
    if (fallbackHook == null || beforeSendHook == null) {
      throw new Error('Expected the sampling fallback and session before-send hooks to be registered.');
    }
    expectSampledItem(beforeSendHook(sessionItem(true)));

    const storedSession = VolatileSessionsManager.fetchUserSession();
    if (storedSession == null) {
      throw new Error('Expected an active volatile session before cleanup.');
    }
    const unsampledSession = {
      ...storedSession,
      isSampled: false,
      sessionMeta: {
        ...storedSession.sessionMeta,
        id: storedSession.sessionId,
        attributes: {
          ...storedSession.sessionMeta?.attributes,
          isSampled: 'false',
        },
      },
    };
    VolatileSessionsManager.storeUserSession(unsampledSession);
    faro.api.setSession(unsampledSession.sessionMeta);
    expect(faro.api.getSession()?.attributes?.['isSampled']).toBe('false');
    const sessionStartsBeforeDestroy = sessionStartCount(transport);
    instrumentation.destroy();

    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(new Set(removeListenerSpy.mock.calls.map(([listener]) => listener))).toStrictEqual(
      new Set(registeredListeners)
    );
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledWith(beforeSendHook);
    // A detached session hook must not rotate sessions, but a captured queued
    // item still carries the sampling decision that the hook must enforce.
    expect(beforeSendHook(sessionItem(false))).toBeNull();
    expectSampledItem(beforeSendHook(sessionItem(true)));
    expect(fallbackHook(sessionItem(false))).toBeNull();
    expectSampledItem(fallbackHook(sessionItem(true)));

    expect(faro.api.getSession()?.attributes?.['isSampled']).toBeUndefined();
    const itemsAfterDestroy = transport.items.length;
    faro.transports.execute(sessionItem(false));
    expect(transport.items).toHaveLength(itemsAfterDestroy);
    faro.transports.execute(sessionItem(true));
    expect(transport.items).toHaveLength(itemsAfterDestroy + 1);
    expect(transport.items.at(-1)?.meta.session?.attributes?.['isSampled']).toBeUndefined();

    faro.api.pushEvent('after-destroy');
    expect(transport.items.at(-1)?.payload).toEqual(expect.objectContaining({ name: 'after-destroy' }));
    expect(transport.items.at(-1)?.meta.session?.attributes?.['isSampled']).toBeUndefined();

    faro.api.setSession({ id: 'after-cleanup' });
    expect(sessionStartCount(transport)).toBe(sessionStartsBeforeDestroy);

    instrumentation.destroy();
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sampled', 1, 1],
    ['unsampled', 0, 0],
  ] as const)('keeps teardown listener telemetry attributed for a %s session', async (_name, rate, expectedCount) => {
    const transport = new MockTransport();
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [transport],
        url: 'http://localhost:12345/collect',
        view: { name: 'configured-view' },
        sessionTracking: {
          enabled: true,
          persistent: false,
          sampling: { resolve: () => rate },
        },
      })
    );
    const instrumentation = new SessionInstrumentation();
    const checkSessionSpy = jest.spyOn(VolatileSessionsManager.prototype, 'checkSession');
    faro.instrumentations.add(instrumentation);
    faro.instrumentations.add(new ViewInstrumentation());
    const storedSession = VolatileSessionsManager.fetchUserSession();
    if (storedSession == null) {
      throw new Error('Expected an active volatile session before cleanup.');
    }
    expect(storedSession.isSampled).toBe(rate === 1);
    checkSessionSpy.mockClear();
    const itemsBeforeDestroy = transport.items.length;

    instrumentation.destroy();

    expect(checkSessionSpy).not.toHaveBeenCalled();
    const teardownItems = transport.items.slice(itemsBeforeDestroy);
    const viewChangedItems = teardownItems.filter(
      (item) => item.type === TransportItemType.EVENT && item.payload.name === EVENT_VIEW_CHANGED
    );
    expect(viewChangedItems).toHaveLength(expectedCount);
    if (expectedCount === 1) {
      expect(viewChangedItems[0]?.meta.session?.id).toBe(storedSession.sessionId);
      expect(viewChangedItems[0]?.meta.session?.attributes?.['isSampled']).toBeUndefined();
    }
  });

  it('finishes cleanup when a metas listener throws during the sampling scrub', async () => {
    const faro = await initializeWithoutInstrumentations();
    const instrumentation = new SessionInstrumentation();
    const removeBeforeSendHooksSpy = jest.spyOn(faro.transports, 'removeBeforeSendHooks');
    const checkSessionSpy = jest.spyOn(VolatileSessionsManager.prototype, 'checkSession');
    faro.instrumentations.add(instrumentation);
    const beforeSendHook = faro.transports.getBeforeSendHooks().at(-1);
    if (beforeSendHook == null) {
      throw new Error('Expected a session before-send hook before cleanup.');
    }
    const throwingListener = jest.fn((meta) => {
      if (meta.session == null) {
        throw new Error('metas listener failed');
      }
    });
    faro.metas.addListener(throwingListener);

    expect(() => instrumentation.destroy()).toThrow('metas listener failed');
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledTimes(1);
    expect(removeBeforeSendHooksSpy).toHaveBeenCalledWith(beforeSendHook);

    faro.metas.removeListener(throwingListener);
    checkSessionSpy.mockClear();
    faro.api.pushEvent('after-failed-cleanup');
    expect(checkSessionSpy).not.toHaveBeenCalled();

    expect(() => instrumentation.destroy()).not.toThrow();
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

  it('binds a persistent manager listener to the supplied metas instance', async () => {
    const registeredFaro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(registeredFaro.metas, 'addListener');
    const removeRegisteredListenerSpy = jest.spyOn(registeredFaro.metas, 'removeListener');
    const replacementFaro = await initializeWithoutInstrumentations();
    const addReplacementListenerSpy = jest.spyOn(replacementFaro.metas, 'addListener');
    const removeReplacementListenerSpy = jest.spyOn(replacementFaro.metas, 'removeListener');
    jest.spyOn(MmkvPersistentSessionsManager, 'fetchUserSession').mockReturnValue(null);
    jest.spyOn(MmkvPersistentSessionsManager, 'storeUserSession').mockImplementation();
    const manager = new MmkvPersistentSessionsManager(registeredFaro.metas);
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
    const firstRemoveBeforeSendHooksSpy = jest.spyOn(firstFaro.transports, 'removeBeforeSendHooks');
    const firstSetSessionSpy = jest.spyOn(firstFaro.api, 'setSession');
    firstFaro.instrumentations.add(instrumentation);
    const firstHook = firstFaro.transports.getBeforeSendHooks().at(-1);
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
    expect(firstRemoveBeforeSendHooksSpy).toHaveBeenCalledWith(firstHook);
    expect(firstSetSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.not.objectContaining({ isSampled: expect.anything() }),
      })
    );
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
    const firstHook = faro.transports.getBeforeSendHooks().at(-1);
    if (firstHook == null) {
      throw new Error('Expected the first instrumentation to register a session hook.');
    }

    faro.instrumentations.remove(firstInstrumentation);
    expect(faro.instrumentations.instrumentations).not.toContain(firstInstrumentation);
    expect(faro.instrumentations.instrumentations).toHaveLength(0);

    const replacementInstrumentation = new SessionInstrumentation();
    faro.instrumentations.add(replacementInstrumentation);
    expect(faro.instrumentations.instrumentations).toContain(replacementInstrumentation);

    const activeSession = VolatileSessionsManager.fetchUserSession();
    if (activeSession == null) {
      throw new Error('Expected the replacement instrumentation to own a session.');
    }

    const installedHooks = faro.transports.getBeforeSendHooks();
    const hooks = installedHooks.includes(firstHook) ? installedHooks : [firstHook, ...installedHooks];
    const result = hooks.reduce<TransportItem | null>(
      (item, hook) => (item == null ? null : hook(item)),
      sessionItem(false)
    );
    const sampledResult = expectSampledItem(result);

    expect(sampledResult.meta.session?.id).toBe(activeSession.sessionId);
    replacementInstrumentation.destroy();
  });

  it('registers its manager listener on the instrumentation metas instance', async () => {
    const ownerFaro = await initializeWithoutInstrumentations();
    const ownerAddListenerSpy = jest.spyOn(ownerFaro.metas, 'addListener');
    const otherFaro = await initializeWithoutInstrumentations();
    const otherAddListenerSpy = jest.spyOn(otherFaro.metas, 'addListener');
    const instrumentation = new SessionInstrumentation();

    ownerFaro.instrumentations.add(instrumentation);

    expect(ownerAddListenerSpy).toHaveBeenCalledTimes(2);
    expect(otherAddListenerSpy).not.toHaveBeenCalled();

    instrumentation.destroy();
  });
});
