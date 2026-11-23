import { bytesToMb, cpuUtilization, formatCpuPercent } from './processUsage';
import type { PerformanceSnapshot } from './processUsage';

const start: PerformanceSnapshot = {
  cpuTimeMs: 100,
  elapsedMs: 1000,
  logicalCount: 8,
  timestampMs: 0,
  memoryBytes: null,
};
const end = { ...start, cpuTimeMs: 30100, elapsedMs: 31000 };
it('divides by available CPUs at window end, including idle and 100%', () => {
  expect(cpuUtilization(start, end)).toBe(12.5);
  expect(cpuUtilization(start, { ...end, logicalCount: 4 })).toBe(25);
  expect(cpuUtilization(start, { ...end, cpuTimeMs: 100 })).toBe(0);
  expect(cpuUtilization(start, { ...end, cpuTimeMs: 240100 })).toBe(100);
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid count %s', (logicalCount) => {
  expect(cpuUtilization(start, { ...end, logicalCount })).toBeNull();
});
it.each([0, 240101, NaN, Infinity, null])('rejects invalid CPU total %s', (cpuTimeMs) => {
  expect(cpuUtilization(start, { ...end, cpuTimeMs })).toBeNull();
});
it.each([1000, 0, NaN, Infinity])('rejects invalid window end %s', (elapsedMs) => {
  expect(cpuUtilization(start, { ...end, elapsedMs })).toBeNull();
});
it('requires both CPU counters', () => {
  expect(cpuUtilization({ ...start, cpuTimeMs: null }, end)).toBeNull();
});
it.each([
  [0, '0'],
  [7.814, '7.81'],
  [7.816, '7.82'],
  [100, '100'],
])('formats CPU %s', (value, formatted) => {
  expect(formatCpuPercent(value as number)).toBe(formatted);
});
it.each([
  [1048576, '1'],
  [1048576 * 12.34, '12.3'],
  [1048576 * 12.36, '12.4'],
  [1048576 * 0.06, '0.1'],
])('converts bytes %s to MB', (bytes, formatted) => {
  expect(bytesToMb(bytes as number)).toBe(formatted);
});
it.each([null, 0, -1, NaN, Infinity])('omits unavailable memory %s', (bytes) => {
  expect(bytesToMb(bytes)).toBeNull();
});
