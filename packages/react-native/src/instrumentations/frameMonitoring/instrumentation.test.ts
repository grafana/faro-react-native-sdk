import { NativeModules, Platform } from 'react-native';

import { initializeFaro, type MeasurementEvent, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { FrameMonitoringInstrumentation } from './instrumentation';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    FaroReactNativeModule: {
      startFrameMonitoring: jest.fn(),
      getFrameMetrics: jest.fn(),
      getRefreshRate: jest.fn().mockResolvedValue(null),
      stopFrameMonitoring: jest.fn(),
    },
  },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
}));

const POLL_INTERVAL_MS = 1000;

function getNativeModule() {
  return NativeModules.FaroReactNativeModule as {
    startFrameMonitoring: jest.Mock;
    getFrameMetrics: jest.Mock;
    getRefreshRate: jest.Mock;
    stopFrameMonitoring: jest.Mock;
  };
}

function getFrozenFrameMeasurements(transport: MockTransport): MeasurementEvent[] {
  return transport.items
    .map((item) => item as TransportItem<MeasurementEvent>)
    .filter((item) => item.type === 'measurement' && item.payload.type === 'app_frozen_frame')
    .map((item) => item.payload);
}

describe('FrameMonitoringInstrumentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    getNativeModule().getFrameMetrics.mockResolvedValue(null);
    getNativeModule().getRefreshRate.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends app_frozen_frame once per poll when frozen frames are reported', async () => {
    const transport = new MockTransport();
    getNativeModule().getFrameMetrics.mockResolvedValue({
      refreshRate: 60,
      slowFrames: 0,
      frozenFrames: 2,
      frozenDurationMs: 1550,
    });

    initializeFaro(
      mockConfig({
        refreshRateVitals: true,
        transports: [transport],
        instrumentations: [new FrameMonitoringInstrumentation({ refreshRatePollingInterval: POLL_INTERVAL_MS })],
      })
    );

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const measurements = getFrozenFrameMeasurements(transport);
    expect(measurements).toHaveLength(1);
    expect(measurements[0].values).toEqual({
      frozen_frames: 2,
      frozen_duration: 1550,
    });
  });

  it('skips app_frozen_frame when frozen frame count is zero', async () => {
    const transport = new MockTransport();
    getNativeModule().getFrameMetrics.mockResolvedValue({
      refreshRate: 60,
      slowFrames: 0,
      frozenFrames: 0,
      frozenDurationMs: 0,
    });

    initializeFaro(
      mockConfig({
        refreshRateVitals: true,
        transports: [transport],
        instrumentations: [new FrameMonitoringInstrumentation({ refreshRatePollingInterval: POLL_INTERVAL_MS })],
      })
    );

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(getFrozenFrameMeasurements(transport)).toHaveLength(0);
  });

  it('does not send app_frozen_frame when duration is zero even if count is positive', async () => {
    const transport = new MockTransport();
    getNativeModule().getFrameMetrics.mockResolvedValue({
      refreshRate: 60,
      slowFrames: 0,
      frozenFrames: 1,
      frozenDurationMs: 0,
    });

    initializeFaro(
      mockConfig({
        refreshRateVitals: true,
        transports: [transport],
        instrumentations: [new FrameMonitoringInstrumentation({ refreshRatePollingInterval: POLL_INTERVAL_MS })],
      })
    );

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(getFrozenFrameMeasurements(transport)).toHaveLength(0);
  });

  it('reports frozen frames through polling only on Android (no duplicate event path)', async () => {
    const transport = new MockTransport();
    getNativeModule()
      .getFrameMetrics.mockResolvedValueOnce({
        refreshRate: 60,
        slowFrames: 0,
        frozenFrames: 1,
        frozenDurationMs: 850,
      })
      .mockResolvedValueOnce({
        refreshRate: 60,
        slowFrames: 0,
        frozenFrames: 0,
        frozenDurationMs: 0,
      });

    initializeFaro(
      mockConfig({
        refreshRateVitals: true,
        transports: [transport],
        instrumentations: [new FrameMonitoringInstrumentation({ refreshRatePollingInterval: POLL_INTERVAL_MS })],
      })
    );

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(getFrozenFrameMeasurements(transport)).toHaveLength(1);
    expect(Platform.OS).toBe('android');
    expect(getNativeModule().startFrameMonitoring).toHaveBeenCalledTimes(1);
  });
});
