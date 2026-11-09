import { DefaultConnectivityService } from './ConnectivityService';

jest.mock(
  '@react-native-community/netinfo',
  () => {
    throw new Error('NetInfo is not installed');
  },
  { virtual: true }
);

describe('DefaultConnectivityService polling', () => {
  let service: DefaultConnectivityService | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    service?.dispose();
    service = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('clears the request timeout when the connectivity check fails', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    service = new DefaultConnectivityService();
    await Promise.resolve();

    expect(service.isOnline).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    service.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the request timeout when the connectivity check succeeds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    service = new DefaultConnectivityService();
    await Promise.resolve();

    expect(service.isOnline).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('still aborts a connectivity check that exceeds its deadline', async () => {
    let signal: AbortSignal | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    service = new DefaultConnectivityService();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(service.isOnline).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('clears the timeout if fetch throws before returning a promise', () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('fetch unavailable');
    });

    service = new DefaultConnectivityService();

    expect(service.isOnline).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('keeps polling and reports recovery after a failed request', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    service = new DefaultConnectivityService();
    const listener = jest.fn();
    service.subscribe(listener);
    await Promise.resolve();

    expect(service.isOnline).toBe(false);
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.isOnline).toBe(true);
    expect(listener.mock.calls.map(([online]) => online)).toEqual([true, false, true]);
    expect(jest.getTimerCount()).toBe(1);
  });
});
