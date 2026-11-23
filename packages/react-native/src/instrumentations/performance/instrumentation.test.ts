import { AppState, NativeModules, Platform } from 'react-native';

import { initializeFaro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { PerformanceInstrumentation } from './index';
import { cpuUtilization } from './processUsage';
import type { PerformanceSnapshot } from './processUsage';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: jest.fn() },
  NativeModules: { FaroReactNativeModule: { getPerformanceSnapshot: jest.fn() } },
}));
const read = NativeModules.FaroReactNativeModule.getPerformanceSnapshot;
const sample = (elapsedMs = 0, cpuTimeMs = 0, memoryBytes: number | null = 1048576 * 12.36): PerformanceSnapshot => ({
  elapsedMs,
  cpuTimeMs,
  memoryBytes,
  logicalCount: 8,
  timestampMs: 1700000000000 + elapsedMs,
});
let change: (state: string) => void;
let frame: PerformanceInstrumentation;
let transport: MockTransport;
let faro: ReturnType<typeof initializeFaro>;
const remove = jest.fn();
async function setup(state: string | null = 'active', options = {}) {
  Object.assign(AppState, { currentState: state });
  frame = new PerformanceInstrumentation(options);
  transport = new MockTransport();
  faro = initializeFaro(
    mockConfig({ isolate: true, dedupe: true, transports: [transport], instrumentations: [frame] })
  );
  await jest.advanceTimersByTimeAsync(0);
}
function events() {
  return transport.items.map((item) => item.payload);
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
  Platform.OS = 'android';
  jest.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
    change = listener;
    return { remove };
  });
  const origin = Date.now();
  read.mockImplementation(async () => sample(Date.now() - origin));
});
afterEach(() => {
  frame?.unpatch();
  jest.useRealTimers();
});

it('uses window-end CPU count, including idle 0 and rounded busy utilization', () => {
  expect(cpuUtilization(sample(), sample(30000, 30000))).toBe(12.5);
  expect(cpuUtilization(sample(), { ...sample(30000, 30000), logicalCount: 4 })).toBe(25);
  expect(cpuUtilization(sample(), sample(30000, 0))).toBe(0);
});
it.each([-1, 240001, NaN, Infinity])('drops invalid CPU delta %s without clamping', (cpu) => {
  expect(cpuUtilization(sample(), sample(30000, cpu))).toBeNull();
});
it('emits exact event payloads and native timestamps, never measurements', async () => {
  await setup();
  expect(events()).toEqual([]);
  await jest.advanceTimersByTimeAsync(2000);
  await jest.advanceTimersByTimeAsync(28000);
  expect(events()).toEqual(
    [
      {
        name: 'app.memory',
        attributes: { value: '12.4', unit: 'MB', 'memory.basis': 'rss' },
        timestamp: new Date(1700000002000).toISOString(),
      },
      {
        name: 'app.cpu_usage',
        attributes: {
          value: '0',
          unit: 'percent',
          'cpu.logical_count': '8',
          window_ms: '30000',
          'cpu.basis': 'process_utilization',
        },
        timestamp: new Date(1700000030000).toISOString(),
      },
      {
        name: 'app.memory',
        attributes: { value: '12.4', unit: 'MB', 'memory.basis': 'rss' },
        timestamp: new Date(1700000030000).toISOString(),
      },
    ].map((event) => expect.objectContaining(event))
  );
  expect(transport.items.every((item) => item.type === 'event')).toBe(true);
  expect(read.mock.calls).toEqual([
    [true, false],
    [false, true],
    [true, true],
  ]);
});
it('rounds CPU to two decimals', async () => {
  read.mockResolvedValueOnce(sample()).mockResolvedValueOnce(sample(2000)).mockResolvedValueOnce(sample(30000, 12345));
  await setup();
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toContainEqual(
    expect.objectContaining({ name: 'app.cpu_usage', attributes: expect.objectContaining({ value: '5.14' }) })
  );
});
it.each([null, 0, NaN, Infinity, -1])('omits failed/invalid memory %s', async (memory) => {
  read.mockResolvedValue(sample(2000, 0, memory));
  await setup();
  await jest.advanceTimersByTimeAsync(2000);
  expect(events()).toEqual([]);
});
it('handles rejected reads and retries without placeholders', async () => {
  await setup();
  read.mockRejectedValueOnce(new Error('read failure'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(events()).toEqual([]);
  await jest.advanceTimersByTimeAsync(28000);
  expect(transport.items).toHaveLength(2);
});
it.each(['background', 'unknown', 'extension', null])('waits for visibility from %s', async (state) => {
  await setup(state);
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).not.toHaveBeenCalled();
  change('active');
  await jest.advanceTimersByTimeAsync(2000);
  expect(transport.items).toHaveLength(1);
});
it('keeps iOS inactive visible and emits footprint MB', async () => {
  Platform.OS = 'ios';
  await setup('inactive');
  await jest.advanceTimersByTimeAsync(2000);
  change('active');
  await jest.advanceTimersByTimeAsync(28000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(events()[0]).toEqual(
    expect.objectContaining({ attributes: expect.objectContaining({ 'memory.basis': 'phys_footprint' }) })
  );
});
it('cancels early memory and discards partial windows across hide/show', async () => {
  await setup();
  await jest.advanceTimersByTimeAsync(1000);
  change('background');
  await jest.advanceTimersByTimeAsync(60000);
  expect(events()).toEqual([]);
  expect(read).toHaveBeenCalledTimes(1);
  change('active');
  await jest.advanceTimersByTimeAsync(2000);
  expect(transport.items).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(28000);
  expect(transport.items).toHaveLength(3);
});
it('discards >2x stalled windows including memory, then uses a fresh baseline', async () => {
  read
    .mockResolvedValueOnce(sample())
    .mockResolvedValueOnce(sample(2000))
    .mockResolvedValueOnce(sample(90000, 10000))
    .mockResolvedValueOnce(sample(120000, 40000));
  await setup();
  await jest.advanceTimersByTimeAsync(30000);
  expect(transport.items).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toContainEqual(
    expect.objectContaining({
      name: 'app.cpu_usage',
      attributes: expect.objectContaining({ value: '12.5', window_ms: '30000' }),
    })
  );
});
it.each(['hide', 'unpatch', 'reinit'])('ignores pending async results after %s', async (action) => {
  await setup();
  let resolve: (value: PerformanceSnapshot) => void = () => {};
  read.mockReturnValueOnce(
    new Promise<PerformanceSnapshot>((done) => {
      resolve = done;
    })
  );
  await jest.advanceTimersByTimeAsync(2000);
  if (action === 'hide') {
    change('background');
  } else if (action === 'unpatch') {
    frame.unpatch();
  } else {
    frame.initialize();
  }
  resolve(sample(2000));
  await jest.advanceTimersByTimeAsync(0);
  expect(events()).toEqual([]);
  frame.unpatch();
  expect(remove).toHaveBeenCalled();
});

it.each([
  { cpuUsageVitals: true, memoryUsageVitals: false },
  { cpuUsageVitals: false, memoryUsageVitals: true },
])('retains identical consecutive samples with Faro dedupe enabled (%j)', async (options) => {
  await setup('active', options);
  await jest.advanceTimersByTimeAsync(60000);
  expect(transport.items).toHaveLength(options.cpuUsageVitals ? 2 : 3);
});

it.each([true, false])('emits periodic memory despite null CPU (CPU enabled: %s)', async (cpuUsageVitals) => {
  read.mockImplementation(async () => ({ ...sample(Date.now()), cpuTimeMs: null }));
  await setup('active', { cpuUsageVitals });
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toHaveLength(2);
  expect(events().every((event) => 'name' in event && event.name === 'app.memory')).toBe(true);
  expect(read.mock.calls[0]).toEqual([cpuUsageVitals, false]);
});
it('accepts exactly twice the interval and uses CPU count at window end', async () => {
  read
    .mockResolvedValueOnce(sample())
    .mockResolvedValueOnce(sample(2000))
    .mockResolvedValueOnce({ ...sample(60000, 60000), logicalCount: 4 });
  await setup();
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toContainEqual(
    expect.objectContaining({
      name: 'app.cpu_usage',
      attributes: expect.objectContaining({ value: '25', window_ms: '60000', 'cpu.logical_count': '4' }),
    })
  );
});
it.each([0, -1, NaN, Infinity])('falls back to 30s for interval %s', async (fetchVitalsInterval) => {
  await setup('active', { fetchVitalsInterval });
  await jest.advanceTimersByTimeAsync(29999);
  expect(events()).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(events()).toHaveLength(3);
});
it('does not read memory when disabled', async () => {
  await setup('active', { memoryUsageVitals: false });
  await jest.advanceTimersByTimeAsync(30000);
  expect(read.mock.calls).toEqual([
    [true, false],
    [true, false],
  ]);
  expect(events()).toHaveLength(1);
});
it('does nothing when both signals are disabled', async () => {
  await setup('active', { cpuUsageVitals: false, memoryUsageVitals: false });
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).not.toHaveBeenCalled();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
});
it.each([undefined, { getCpuUsage: jest.fn(), getMemoryUsage: jest.fn() }])(
  'ignores missing or sync-only native modules: %j',
  async (native) => {
    const original = NativeModules.FaroReactNativeModule;
    try {
      NativeModules.FaroReactNativeModule = native;
      await setup();
      await jest.advanceTimersByTimeAsync(30000);
      expect(events()).toEqual([]);
      expect(AppState.addEventListener).not.toHaveBeenCalled();
    } finally {
      NativeModules.FaroReactNativeModule = original;
    }
  }
);
it.each(['unpatch', 'reinit'])('rejects retained AppState callback after %s', async (action) => {
  await setup();
  const oldChange = change;
  frame.unpatch();
  if (action === 'reinit') {
    Object.assign(AppState, { currentState: 'background' });
    frame.initialize();
  }
  read.mockClear();
  oldChange('active');
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).not.toHaveBeenCalled();
  expect(events()).toEqual([]);
});
it('invalidates ownership before removing a throwing subscription', async () => {
  await setup();
  remove.mockImplementation(() => {
    throw new Error('remove failed');
  });
  expect(() => frame.unpatch()).not.toThrow();
  change('active');
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(events()).toEqual([]);
});
it('stops between emissions when CPU pushEvent removes the instrumentation', async () => {
  await setup('active', { memoryUsageVitals: true });
  await jest.advanceTimersByTimeAsync(2000);
  const push = jest.spyOn(frame.api, 'pushEvent');
  push.mockImplementation(() => frame.unpatch());
  await jest.advanceTimersByTimeAsync(28000);
  expect(push).toHaveBeenCalledTimes(1);
  expect(push.mock.calls[0][0]).toBe('app.cpu_usage');
  expect(jest.getTimerCount()).toBe(0);
  push.mockRestore();
});
it('cleans up and restarts when removed/re-added through Faro', async () => {
  await setup();
  faro.instrumentations.remove(frame);
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toEqual([]);
  faro.instrumentations.add(frame);
  await jest.advanceTimersByTimeAsync(30000);
  expect(events()).toHaveLength(3);
});
it('uses native timestamps on delayed resolves and compensates the next delay', async () => {
  await setup('active', { memoryUsageVitals: false });
  let resolve: (snapshot: PerformanceSnapshot) => void = () => {};
  read.mockReturnValueOnce(
    new Promise<PerformanceSnapshot>((done) => {
      resolve = done;
    })
  );
  await jest.advanceTimersByTimeAsync(30000);
  await jest.advanceTimersByTimeAsync(5000);
  resolve(sample(32000, 32000));
  await jest.advanceTimersByTimeAsync(0);
  expect(events()).toContainEqual(
    expect.objectContaining({ name: 'app.cpu_usage', timestamp: new Date(1700000032000).toISOString() })
  );
  await jest.advanceTimersByTimeAsync(24999);
  expect(read).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
});
it('uses the native read timestamp for delayed visible memory', async () => {
  await setup();
  let resolve: (snapshot: PerformanceSnapshot) => void = () => {};
  read.mockReturnValueOnce(
    new Promise<PerformanceSnapshot>((done) => {
      resolve = done;
    })
  );
  await jest.advanceTimersByTimeAsync(7000);
  resolve(sample(4000));
  await jest.advanceTimersByTimeAsync(0);
  expect(events()).toEqual([
    expect.objectContaining({ name: 'app.memory', timestamp: new Date(1700000004000).toISOString() }),
  ]);
});
it('times out a read that never settles, ignores its late reply and keeps sampling', async () => {
  let resolveHung: (snapshot: PerformanceSnapshot) => void = () => undefined;
  read.mockImplementationOnce(
    () =>
      new Promise<PerformanceSnapshot>((resolve) => {
        resolveHung = resolve;
      })
  );
  await setup();
  // The 2 s memory read still works; the hung opening read times out at 10 s.
  await jest.advanceTimersByTimeAsync(10000);
  expect(events().map((event) => event.name)).toEqual(['app.memory']);
  resolveHung(sample(0, 0));
  await jest.advanceTimersByTimeAsync(29999);
  expect(read).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  await jest.advanceTimersByTimeAsync(30000);
  expect(events().map((event) => event.name)).toEqual(['app.memory', 'app.cpu_usage', 'app.memory']);
  expect(events()[1]?.attributes).toMatchObject({ window_ms: '30000' });
});
it('caps the read timeout at the interval when the interval is shorter than 10 s', async () => {
  read.mockImplementationOnce(() => new Promise<PerformanceSnapshot>(() => undefined));
  await setup('active', { fetchVitalsInterval: 4000, memoryUsageVitals: false });
  await jest.advanceTimersByTimeAsync(7999);
  expect(read).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
});
