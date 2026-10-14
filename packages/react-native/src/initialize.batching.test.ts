import type { Faro } from '@grafana/faro-core';

import type { ReactNativeConfig } from './config/types';
import { initializeFaro } from './initialize';

// Keep native instrumentation signals out of the batch so its contents and
// thresholds are controlled by the events below. Core and FetchTransport are real.
jest.mock('./config/getRNInstrumentations', () => ({ getRNInstrumentations: () => [] }));

describe('initializeFaro batching delivery', () => {
  let faro: Faro | undefined;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
  });

  afterEach(() => {
    faro?.transports.pause();
    faro = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    fetchSpy.mockRestore();
  });

  async function initialize(batching?: ReactNativeConfig['batching']): Promise<Faro> {
    faro = await initializeFaro({
      app: { name: 'batching-test' },
      url: 'https://faro.example.com/collect',
      batching,
      isolate: true,
      preventGlobalExposure: true,
      sessionTracking: { enabled: false, persistent: false },
    });
    return faro;
  }

  function expectRequestEvents(names: string[]): void {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://faro.example.com/collect');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body).events.map((event: { name: string }) => event.name)).toEqual(names);
  }

  it('waits for the configured timer when the batch is below the item limit', async () => {
    const instance = await initialize({ enabled: true, sendTimeout: 2000, itemLimit: 200 });
    instance.api.pushEvent('first');
    instance.api.pushEvent('second');

    await jest.advanceTimersByTimeAsync(1999);
    expect(fetchSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expectRequestEvents(['first', 'second']);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes at the configured item limit before the timer elapses', async () => {
    const instance = await initialize({ enabled: true, sendTimeout: 10000, itemLimit: 2 });
    instance.api.pushEvent('first');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    instance.api.pushEvent('second');
    await jest.advanceTimersByTimeAsync(0);
    expectRequestEvents(['first', 'second']);
    await jest.advanceTimersByTimeAsync(10000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { enabled: false, sendTimeout: 2000, itemLimit: 200 }])(
    'sends immediately when batching is %p',
    async (batching) => {
      const instance = await initialize(batching);
      instance.api.pushEvent('immediate');
      await jest.advanceTimersByTimeAsync(0);
      expectRequestEvents(['immediate']);
    }
  );
});
