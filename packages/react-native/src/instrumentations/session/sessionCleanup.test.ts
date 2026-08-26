import { initializeFaro, TransportItemType } from '@grafana/faro-core';
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

  it('removes manager and instrumentation listeners through the Faro lifecycle', async () => {
    const faro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(faro.metas, 'addListener');
    const removeListenerSpy = jest.spyOn(faro.metas, 'removeListener');
    const instrumentation = new SessionInstrumentation();

    faro.instrumentations.add(instrumentation);

    const registeredListeners = addListenerSpy.mock.calls.map(([listener]) => listener);
    expect(registeredListeners).toHaveLength(2);

    const beforeSendHook = faro.transports.getBeforeSendHooks()[0];
    if (beforeSendHook == null) {
      throw new Error('Expected the session before-send hook to be registered.');
    }
    const item: TransportItem = {
      type: TransportItemType.EVENT,
      payload: { name: 'test' },
      meta: { session: { id: 'active-session', attributes: { isSampled: 'true' } } },
    };
    expect(beforeSendHook(item)).not.toBe(item);

    faro.instrumentations.remove(instrumentation);

    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(new Set(removeListenerSpy.mock.calls.map(([listener]) => listener))).toStrictEqual(
      new Set(registeredListeners)
    );
    expect(beforeSendHook(item)).toBe(item);

    instrumentation.destroy();
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
  });

  it('removes a manager listener from the metas instance that registered it', async () => {
    const registeredFaro = await initializeWithoutInstrumentations();
    const addListenerSpy = jest.spyOn(registeredFaro.metas, 'addListener');
    const removeRegisteredListenerSpy = jest.spyOn(registeredFaro.metas, 'removeListener');
    const manager = new VolatileSessionsManager();
    const handler = addListenerSpy.mock.calls[0]?.[0];
    const replacementFaro = await initializeWithoutInstrumentations();
    const removeReplacementListenerSpy = jest.spyOn(replacementFaro.metas, 'removeListener');

    manager.unpatch();

    expect(removeRegisteredListenerSpy).toHaveBeenCalledWith(handler);
    expect(removeReplacementListenerSpy).not.toHaveBeenCalled();
  });
});
