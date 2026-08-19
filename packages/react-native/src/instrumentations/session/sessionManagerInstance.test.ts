import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { initializeFaro } from '../../initialize';

import { SessionInstrumentation } from './index';
import { SessionActivityKind } from './sessionActivity';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

describe('SessionInstrumentation session manager', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('constructs a single session manager', async () => {
    // Constructing a manager subscribes to AppState and to metas, and only the
    // instance held by the instrumentation can be unpatched. A second, discarded
    // instance would leak both subscriptions for the lifetime of the app.
    const initSpy = jest.spyOn(VolatileSessionsManager.prototype as never, 'init' as never);

    await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes activity only after returning from the background', async () => {
    await initializeFaro(
      mockConfig({
        url: 'http://localhost:12345/collect',
        transports: [new MockTransport()],
        instrumentations: [],
        sessionTracking: { enabled: true, persistent: false },
      })
    );
    const manager = new VolatileSessionsManager();
    const checkSessionSpy = jest.spyOn(manager, 'checkSession');
    const handleAppStateChange = (
      manager as unknown as { handleAppStateChange: (state: 'active' | 'background' | 'inactive') => void }
    ).handleAppStateChange;

    handleAppStateChange('active');
    checkSessionSpy.mockClear();
    handleAppStateChange('inactive');
    handleAppStateChange('active');
    expect(checkSessionSpy).not.toHaveBeenCalled();

    handleAppStateChange('background');
    handleAppStateChange('inactive');
    handleAppStateChange('active');
    expect(checkSessionSpy).toHaveBeenCalledTimes(1);
    expect(checkSessionSpy).toHaveBeenCalledWith(SessionActivityKind.Meaningful);

    manager.unpatch();
  });
});
