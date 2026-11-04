import { AppState, type AppStateStatus, NativeModules } from 'react-native';

import { initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { StartupInstrumentation } from './index';

jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: jest.fn() },
  NativeModules: { FaroReactNativeModule: { getAppStartDuration: jest.fn() } },
}));

describe('StartupInstrumentation', () => {
  let listeners: Set<(state: AppStateStatus) => void>;
  let frames: Map<number, FrameRequestCallback>;
  let instrumentation: StartupInstrumentation;
  let transport: MockTransport;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    listeners = new Set();
    frames = new Map();
    let nextFrameId = 0;
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
      if (id != null) {
        frames.delete(id);
      }
    });
    jest.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
      listeners.add(listener);
      return { remove: jest.fn(() => listeners.delete(listener)) };
    });
    NativeModules['FaroReactNativeModule'].getAppStartDuration.mockReturnValue(0);
    instrumentation = new StartupInstrumentation();
    transport = new MockTransport();
  });

  afterEach(() => {
    instrumentation.unpatch();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function initialize() {
    // Core 2.8.2 only removes the last registered instrumentation.
    return initializeFaro(mockConfig({ transports: [transport], instrumentations: [instrumentation] }));
  }

  function changeState(state: AppStateStatus) {
    listeners.forEach((listener) => listener(state));
  }

  function drawFrame() {
    jest.advanceTimersByTime(16);
    const callbacks = Array.from(frames.values());
    frames.clear();
    callbacks.forEach((callback) => callback(16));
  }

  it('does not count an inactive interruption as a warm start', () => {
    initialize();
    changeState('inactive');
    changeState('active');
    drawFrame();

    expect(transport.items).toHaveLength(0);
  });

  it.each<AppStateStatus>(['background', 'inactive'])('discards a pending warm start on %s', (state) => {
    initialize();
    changeState('background');
    changeState('active');
    const pendingFrame = Array.from(frames.values())[0];
    expect(pendingFrame).toEqual(expect.any(Function));

    changeState(state);
    jest.advanceTimersByTime(16);
    pendingFrame?.(16);

    expect(transport.items).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it('removes listeners and queued measurements through the Faro lifecycle', () => {
    NativeModules['FaroReactNativeModule'].getAppStartDuration.mockReturnValue(120);
    const faro = initialize();
    changeState('background');
    changeState('active');
    const pendingFrame = Array.from(frames.values())[0];
    const retainedListener = Array.from(listeners)[0];
    expect(pendingFrame).toEqual(expect.any(Function));
    expect(retainedListener).toEqual(expect.any(Function));

    faro.instrumentations.remove(instrumentation);
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(100);
    pendingFrame?.(100);
    retainedListener?.('background');
    retainedListener?.('active');
    drawFrame();

    expect(transport.items).toHaveLength(0);
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<{ states: AppStateStatus[] }>([
    { states: ['background', 'active'] },
    { states: ['inactive', 'background', 'inactive', 'active'] },
    { states: ['background', 'background', 'active', 'active'] },
  ])('captures one warm measurement for $states', ({ states }) => {
    initialize();
    states.forEach(changeState);
    drawFrame();

    expect(transport.items).toHaveLength(1);
    expect(transport.items[0]?.payload).toMatchObject({
      type: 'app_startup',
      values: { appStartDuration: 16, coldStart: 0 },
    });
    changeState('active');
    drawFrame();
    expect(transport.items).toHaveLength(1);
  });

  it('does not let a cancelled callback finish a later return', () => {
    initialize();
    changeState('background');
    changeState('active');
    const oldFrame = Array.from(frames.values())[0];
    expect(oldFrame).toEqual(expect.any(Function));
    changeState('background');
    jest.advanceTimersByTime(1000);
    changeState('active');

    oldFrame?.(1000);
    expect(transport.items).toHaveLength(0);
    expect(frames.size).toBe(1);
    drawFrame();
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0]?.payload).toMatchObject({ values: { appStartDuration: 16, coldStart: 0 } });
  });

  it('does not retry an interrupted return without another background transition', () => {
    initialize();
    ['background', 'active', 'inactive', 'active'].forEach((state) => changeState(state as AppStateStatus));
    drawFrame();
    expect(transport.items).toHaveLength(0);
  });

  it('keeps initialization and teardown idempotent', () => {
    NativeModules['FaroReactNativeModule'].getAppStartDuration.mockReturnValue(120);
    initialize();
    instrumentation.initialize();
    expect(listeners.size).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(100);
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0]?.payload).toMatchObject({
      type: 'app_startup',
      values: { appStartDuration: 120, coldStart: 1 },
    });
    instrumentation.unpatch();
    instrumentation.destroy();
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores retained callbacks after removing and reusing the same instance', () => {
    NativeModules['FaroReactNativeModule'].getAppStartDuration.mockReturnValue(120);
    const timers = jest.spyOn(global, 'setTimeout');
    const faro = initialize();
    const coldCallback = timers.mock.calls.find(([, delay]) => delay === 100)?.[0];
    const oldListener = Array.from(listeners)[0];
    changeState('background');
    changeState('active');
    const oldFrame = Array.from(frames.values())[0];
    expect(oldFrame).toEqual(expect.any(Function));
    expect(oldListener).toEqual(expect.any(Function));
    expect(coldCallback).toEqual(expect.any(Function));
    faro.instrumentations.remove(instrumentation);
    faro.instrumentations.add(instrumentation);
    jest.advanceTimersByTime(16);

    oldListener?.('background');
    oldListener?.('active');
    oldFrame?.(16);
    if (typeof coldCallback === 'function') {
      coldCallback();
    }
    expect(transport.items).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(listeners.size).toBe(1);
    // Reinitialization retains the existing cold-start capture behavior.
    jest.advanceTimersByTime(100);
    expect(transport.items).toHaveLength(1);
    changeState('background');
    changeState('active');
    drawFrame();
    expect(transport.items).toHaveLength(2);
  });

  it('does not carry background eligibility into a new lifecycle', () => {
    const faro = initialize();
    changeState('background');
    faro.instrumentations.remove(instrumentation);
    faro.instrumentations.add(instrumentation);
    changeState('active');
    expect(frames.size).toBe(0);
    drawFrame();

    expect(transport.items).toHaveLength(0);
  });

  it('stays disabled when configured off', () => {
    instrumentation = new StartupInstrumentation({ enabled: false });
    initialize();
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(NativeModules['FaroReactNativeModule'].getAppStartDuration).not.toHaveBeenCalled();
  });

  it('still tracks warm starts when the native cold-start getter throws', () => {
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
    NativeModules['FaroReactNativeModule'].getAppStartDuration.mockImplementationOnce(() => {
      throw new Error('native getter failed');
    });
    initialize();
    changeState('background');
    changeState('active');
    drawFrame();
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0]?.payload).toMatchObject({ values: { coldStart: 0 } });
    expect(logError).toHaveBeenCalled();
  });

  it('still tracks warm starts when the native cold-start getter is missing', () => {
    const nativeModule = NativeModules['FaroReactNativeModule'];
    const getter = nativeModule.getAppStartDuration;
    nativeModule.getAppStartDuration = undefined;
    try {
      initialize();
      changeState('background');
      changeState('active');
      drawFrame();
      expect(transport.items).toHaveLength(1);
      expect(transport.items[0]?.payload).toMatchObject({ values: { coldStart: 0 } });
    } finally {
      nativeModule.getAppStartDuration = getter;
    }
  });

  it('does not emit a zero-duration warm measurement', () => {
    initialize();
    changeState('background');
    changeState('active');
    const frame = Array.from(frames.values())[0];
    expect(frame).toEqual(expect.any(Function));
    frame?.(0);
    expect(transport.items).toHaveLength(0);
  });
});
