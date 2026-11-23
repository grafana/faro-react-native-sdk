import { NativeModules, Platform } from 'react-native';

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
    },
  },
}));

const nativeModule = NativeModules.FaroReactNativeModule;
const instances: FrameMonitoringInstrumentation[] = [];
const metrics = { slowFrames: 1, frozenFrames: 1, frozenDurationMs: 1100 };

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

  it('ignores an old getFrameMetrics rejection after restart', async () => {
    const pending = deferred<never>();
    nativeModule.getFrameMetrics.mockReturnValueOnce(pending.promise);
    const { frame, faro } = setup(true);
    const logError = jest.spyOn(frame, 'logError');
    await jest.advanceTimersByTimeAsync(1000);
    faro.instrumentations.remove(frame);
    faro.instrumentations.add(frame);
    pending.reject(new Error('old native request'));
    await jest.advanceTimersByTimeAsync(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not create extra pollers or restart native monitoring on repeated initialization', async () => {
    const { frame } = setup();
    frame.initialize();
    frame.initialize();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.getFrameMetrics).toHaveBeenCalledTimes(1);
  });

  it('discards an old metrics response when reused by a different Faro instance', async () => {
    const pending = deferred<typeof metrics>();
    nativeModule.getFrameMetrics.mockReturnValueOnce(pending.promise);
    const { frame, transport } = setup();
    await jest.advanceTimersByTimeAsync(1000);
    const nextTransport = new MockTransport();
    const nextFaro = initializeFaro(
      mockConfig({ isolate: true, transports: [nextTransport], instrumentations: [frame] })
    );

    pending.resolve(metrics);
    await jest.advanceTimersByTimeAsync(0);
    expect(transport.items).toHaveLength(0);
    expect(nextTransport.items).toHaveLength(0);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);

    nativeModule.getFrameMetrics.mockResolvedValueOnce(metrics);
    await jest.advanceTimersByTimeAsync(1000);
    expect(nextTransport.items).toHaveLength(2);
    expect(transport.items).toHaveLength(0);
    nextFaro.instrumentations.remove(frame);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(2);
  });

  it('ignores an old queued timer after rebinding without adding extra pollers', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    const { frame } = setup();
    const frameTimers = interval.mock.calls.filter(([, delay]) => delay === 1000);
    expect(frameTimers).toHaveLength(1);
    const callback = frameTimers[0][0] as () => void;
    initializeFaro(mockConfig({ isolate: true, transports: [new MockTransport()], instrumentations: [frame] }));
    frame.initialize();
    callback();
    await jest.advanceTimersByTimeAsync(0);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.getFrameMetrics).toHaveBeenCalledTimes(1);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);
  });

  it('cleans up the old Faro when the new one has no native module', async () => {
    const { frame, transport } = setup();
    NativeModules.FaroReactNativeModule = undefined;
    const nextTransport = new MockTransport();
    initializeFaro(mockConfig({ isolate: true, transports: [nextTransport], instrumentations: [frame] }));
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(nativeModule.getFrameMetrics).not.toHaveBeenCalled();

    NativeModules.FaroReactNativeModule = nativeModule;
    nativeModule.getFrameMetrics.mockResolvedValueOnce(metrics);
    frame.initialize();
    await jest.advanceTimersByTimeAsync(1000);
    expect(nextTransport.items).toHaveLength(2);
    expect(transport.items).toHaveLength(0);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);
  });

  it('stops the old poll if delivery registers the instrumentation with another Faro', async () => {
    nativeModule.getFrameMetrics.mockResolvedValue(metrics);
    const { frame, transport } = setup();
    const nextTransport = new MockTransport();
    const originalSend = transport.send.bind(transport);
    jest.spyOn(transport, 'send').mockImplementation((...args) => {
      originalSend(...args);
      initializeFaro(mockConfig({ isolate: true, transports: [nextTransport], instrumentations: [frame] }));
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(transport.items).toHaveLength(1);
    expect(nextTransport.items).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(nextTransport.items).toHaveLength(2);
    expect(nativeModule.startFrameMonitoring).toHaveBeenCalledTimes(2);
  });

  it('keeps the new Faro running after an orderly transfer from the old one', async () => {
    const { frame, faro, transport } = setup();
    faro.instrumentations.remove(frame);
    const nextTransport = new MockTransport();
    const nextFaro = initializeFaro(
      mockConfig({ isolate: true, transports: [nextTransport], instrumentations: [frame] })
    );
    faro.instrumentations.remove(frame);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(1);
    nativeModule.getFrameMetrics.mockResolvedValueOnce(metrics);
    await jest.advanceTimersByTimeAsync(1000);
    expect(nextTransport.items).toHaveLength(2);
    expect(transport.items).toHaveLength(0);
    nextFaro.instrumentations.remove(frame);
    expect(nativeModule.stopFrameMonitoring).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
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

  it.each([false, true])('stops the current poll if a measurement removes it (re-add: %s)', async (readd) => {
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
