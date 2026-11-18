import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { BaseInstrumentation, initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { FrameMonitoringInstrumentation } from './instrumentation';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {
    FaroReactNativeModule: {
      startFrameMonitoring: jest.fn(),
      stopFrameMonitoring: jest.fn(),
      getFrameMetrics: jest.fn(),
      getRefreshRate: jest.fn(),
    },
  },
  NativeEventEmitter: jest.fn(),
}));

const nativeModule = NativeModules.FaroReactNativeModule;
const instances: FrameMonitoringInstrumentation[] = [];
const metrics = { refreshRate: 60, slowFrames: 1, frozenFrames: 1, frozenDurationMs: 1100 };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(refreshRateVitals = false) {
  const frame = new FrameMonitoringInstrumentation({ refreshRatePollingInterval: 1000 });
  instances.push(frame);
  const transport = new MockTransport();
  const faro = initializeFaro(
    mockConfig({ isolate: true, refreshRateVitals, transports: [transport], instrumentations: [frame] })
  );
  return { frame, transport, faro };
}

describe('frame monitoring cleanup', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    nativeModule.getFrameMetrics.mockResolvedValue(null);
    nativeModule.getRefreshRate.mockResolvedValue(null);
    NativeModules.FaroReactNativeModule = nativeModule;
    Platform.OS = 'ios';
  });

  afterEach(() => {
    instances.splice(0).forEach((frame) => frame.unpatch());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('stops polling and native monitoring when removed through Faro', async () => {
    const { frame, faro } = setup();
    const timersBeforeRemoval = jest.getTimerCount();
    faro.instrumentations.remove(frame);
    expect(jest.getTimerCount()).toBe(timersBeforeRemoval - 1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
    expect(faro.instrumentations.instrumentations).not.toContain(frame);
  });

  it.each([false, true])('discards a pending metrics response after removal (re-add: %s)', async (readd) => {
    const pending = deferred<typeof metrics>();
    nativeModule.getFrameMetrics.mockReturnValueOnce(pending.promise);
    const { frame, faro, transport } = setup();
    await jest.advanceTimersByTimeAsync(1000);
    faro.instrumentations.remove(frame);
    if (readd) {
      faro.instrumentations.add(frame);
    }
    pending.resolve(metrics);
    await jest.advanceTimersByTimeAsync(0);
    expect(transport.items).toHaveLength(0);
    if (readd) {
      nativeModule.getFrameMetrics.mockResolvedValueOnce(metrics);
      await jest.advanceTimersByTimeAsync(1000);
      expect(transport.items).toHaveLength(2);
    }
  });

  it.each([false, true])('does not drain metrics after a stale refresh-rate response (re-add: %s)', async (readd) => {
    const pending = deferred<number>();
    nativeModule.getRefreshRate.mockReturnValueOnce(pending.promise);
    const { frame, faro, transport } = setup(true);
    await jest.advanceTimersByTimeAsync(1000);
    faro.instrumentations.remove(frame);
    if (readd) {
      faro.instrumentations.add(frame);
    }
    pending.resolve(60);
    await jest.advanceTimersByTimeAsync(0);
    expect(transport.items).toHaveLength(0);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
  });

  it.each(['getRefreshRate', 'getFrameMetrics'])('ignores an old %s rejection after restart', async (method) => {
    const pending = deferred<never>();
    nativeModule[method].mockReturnValueOnce(pending.promise);
    const { frame, faro } = setup(true);
    const logError = jest.spyOn(frame, 'logError');
    await jest.advanceTimersByTimeAsync(1000);
    faro.instrumentations.remove(frame);
    faro.instrumentations.add(frame);
    pending.reject(new Error('old native request'));
    await jest.advanceTimersByTimeAsync(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it('ignores a retained Android listener after removal and restart', () => {
    Platform.OS = 'android';
    const listeners: Array<(rate: number) => void> = [];
    const remove = jest.fn();
    jest.mocked(NativeEventEmitter).mockImplementation(
      () =>
        ({
          addListener: (_name: string, listener: (rate: number) => void) => {
            listeners.push(listener);
            return { remove };
          },
        }) as unknown as NativeEventEmitter
    );
    const { frame, faro, transport } = setup(true);
    listeners[0](60);
    expect(transport.items).toHaveLength(1);
    faro.instrumentations.remove(frame);
    expect(remove).toHaveBeenCalledTimes(1);
    listeners[0](60);
    faro.instrumentations.add(frame);
    listeners[0](60);
    expect(transport.items).toHaveLength(1);
    listeners[1](60);
    expect(transport.items).toHaveLength(2);
  });

  it('does not create extra pollers or restart native monitoring on repeated initialization', async () => {
    const { frame } = setup();
    frame.initialize();
    frame.initialize();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.getFrameMetrics).toHaveBeenCalledTimes(1);
  });

  it('cleans up only once before allowing the same instance to restart', async () => {
    const { frame, faro } = setup();
    faro.instrumentations.remove(frame);
    frame.unpatch();
    frame.destroy();
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    faro.instrumentations.add(frame);
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);
    expect(nativeModule.getFrameMetrics).toHaveBeenCalledTimes(1);
    faro.instrumentations.remove(frame);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(2);
  });

  it('stops the module it started even if the module registry changes', () => {
    const { frame, faro } = setup();
    NativeModules.FaroReactNativeModule = undefined;
    faro.instrumentations.remove(frame);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
  });

  it('still stops native monitoring when removing an event listener throws', async () => {
    Platform.OS = 'android';
    const remove = jest.fn(() => {
      throw new Error('listener removal failed');
    });
    jest
      .mocked(NativeEventEmitter)
      .mockImplementation(() => ({ addListener: () => ({ remove }) }) as unknown as NativeEventEmitter);
    const { frame, faro } = setup(true);
    const logError = jest.spyOn(frame, 'logError').mockImplementation(() => {});
    expect(() => faro.instrumentations.remove(frame)).not.toThrow();
    expect(logError).toHaveBeenCalledWith('Failed to remove frame event listener', expect.any(Error));
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(nativeModule.getRefreshRate).not.toHaveBeenCalled();
    frame.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['getRefreshRate', false],
    ['getRefreshRate', true],
    ['getFrameMetrics', false],
    ['getFrameMetrics', true],
  ])('stops the current poll if a %s measurement removes it (re-add: %s)', async (method, readd) => {
    nativeModule.getRefreshRate.mockResolvedValue(method === 'getRefreshRate' ? 60 : null);
    nativeModule.getFrameMetrics.mockResolvedValue(metrics);
    const { frame, faro, transport } = setup(true);
    const originalSend = transport.send.bind(transport);
    jest.spyOn(transport, 'send').mockImplementation((...args) => {
      originalSend(...args);
      faro.instrumentations.remove(frame);
      if (readd) {
        faro.instrumentations.add(frame);
      }
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(transport.items).toHaveLength(1);
    if (method === 'getRefreshRate') {
      expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
    }
    if (readd) {
      expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);
    }
  });

  it('removes the frame instrumentation without destroying an earlier instrumentation', async () => {
    class OtherInstrumentation extends BaseInstrumentation {
      readonly name = 'other';
      readonly version = '1.0.0';
      initialize = jest.fn();
      destroy = jest.fn();
    }
    const other = new OtherInstrumentation();
    const { frame, faro } = setup();
    faro.instrumentations.remove(frame);
    nativeModule.stopFrameMonitoring.mockClear();
    faro.instrumentations.add(other, frame);
    faro.instrumentations.remove(frame);
    await jest.advanceTimersByTimeAsync(1000);
    expect(faro.instrumentations.instrumentations).toEqual([other]);
    expect(other.destroy).not.toHaveBeenCalled();
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
  });

  it('can initialize after a missing native module becomes available', async () => {
    NativeModules.FaroReactNativeModule = undefined;
    const { frame } = setup();
    frame.destroy();
    expect(nativeModule.stopFrameMonitoring).not.toHaveBeenCalled();
    NativeModules.FaroReactNativeModule = nativeModule;
    frame.initialize();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.getFrameMetrics).toHaveBeenCalledTimes(1);
  });

  it('keeps polling stopped if native stop throws', async () => {
    const { frame, faro } = setup();
    const logError = jest.spyOn(frame, 'logError').mockImplementation(() => {});
    nativeModule.stopFrameMonitoring.mockImplementationOnce(() => {
      throw new Error('stop failed');
    });
    expect(() => faro.instrumentations.remove(frame)).not.toThrow();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('Failed to stop native frame monitoring', expect.any(Error));
  });

  it('logs a current request failure and recovers on the next poll', async () => {
    const { frame, transport } = setup();
    const logError = jest.spyOn(frame, 'logError').mockImplementation(() => {});
    nativeModule.getFrameMetrics.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(metrics);
    await jest.advanceTimersByTimeAsync(2000);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(transport.items).toHaveLength(2);
  });

  it('ignores a queued timer callback from a removed generation', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    const { frame, faro } = setup();
    const frameTimers = interval.mock.calls.filter(([, delay]) => delay === 1000);
    expect(frameTimers).toHaveLength(1);
    const callback = frameTimers[0][0] as () => void;
    faro.instrumentations.remove(frame);
    faro.instrumentations.add(frame);
    callback();
    await jest.advanceTimersByTimeAsync(0);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
  });
});
