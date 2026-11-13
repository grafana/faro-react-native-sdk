import type { DefaultConnectivityService as Service } from './ConnectivityService';

type NetInfoState = { isConnected: boolean | null };

function load(netInfo: unknown): typeof Service {
  let service: typeof Service | undefined;
  jest.isolateModules(() => {
    jest.doMock(
      '@react-native-community/netinfo',
      () => {
        if (!netInfo) {
          throw new Error('NetInfo is not installed');
        }
        return { default: netInfo };
      },
      { virtual: true }
    );
    service = (require('./ConnectivityService') as { DefaultConnectivityService: typeof Service })
      .DefaultConnectivityService;
  });
  if (!service) {
    throw new Error('not loaded');
  }
  return service;
}

describe('DefaultConnectivityService', () => {
  let service: Service | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    service?.dispose();
    service = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('without NetInfo', () => {
    it('reports online and does not poll or send requests, whatever the interval', () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
      const DefaultConnectivityService = load(null);

      service = new DefaultConnectivityService(1_000);
      const subscriber = jest.fn();
      service.subscribe(subscriber);
      jest.advanceTimersByTime(120_000);

      expect(service.isOnline).toBe(true);
      expect(subscriber).toHaveBeenCalledTimes(1);
      expect(subscriber).toHaveBeenCalledWith(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('with NetInfo', () => {
    function netInfo(initial: NetInfoState) {
      let listener: ((state: NetInfoState) => void) | undefined;
      const unsubscribe = jest.fn();
      return {
        mock: {
          fetch: jest.fn(() => Promise.resolve(initial)),
          addEventListener: jest.fn((callback: (state: NetInfoState) => void) => {
            listener = callback;
            return unsubscribe;
          }),
        },
        emit: (state: NetInfoState) => listener?.(state),
        unsubscribe,
      };
    }

    it('is offline only while NetInfo reports isConnected false, and notifies changes', async () => {
      const fake = netInfo({ isConnected: false });
      const DefaultConnectivityService = load(fake.mock);
      service = new DefaultConnectivityService();
      const subscriber = jest.fn();
      service.subscribe(subscriber);
      await Promise.resolve();
      await Promise.resolve();

      expect(service.isOnline).toBe(false);

      fake.emit({ isConnected: null });
      expect(service.isOnline).toBe(true);
      fake.emit({ isConnected: false });
      fake.emit({ isConnected: true });
      expect(subscriber.mock.calls.map(([online]) => online)).toEqual([true, false, true, false, true]);

      service.dispose();
      expect(fake.unsubscribe).toHaveBeenCalled();
    });

    it('stays online when NetInfo fails', async () => {
      const DefaultConnectivityService = load({
        fetch: () => Promise.reject(new Error('broken')),
        addEventListener: () => {
          throw new Error('broken');
        },
      });
      service = new DefaultConnectivityService();
      await Promise.resolve();
      await Promise.resolve();

      expect(service.isOnline).toBe(true);
    });
  });
});
