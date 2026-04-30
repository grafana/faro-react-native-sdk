import { applyPerformanceObserverPolyfill } from './performanceObserverPolyfill';

describe('applyPerformanceObserverPolyfill', () => {
  const originalPerformance = global.performance;
  const originalPerformanceObserver = global.PerformanceObserver;

  afterEach(() => {
    Object.defineProperty(global, 'performance', {
      configurable: true,
      value: originalPerformance,
      writable: true,
    });
    Object.defineProperty(global, 'PerformanceObserver', {
      configurable: true,
      value: originalPerformanceObserver,
      writable: true,
    });
  });

  it('returns an empty list for unsupported resource timing lookups', () => {
    const getEntriesByType = jest.fn(() => [{ entryType: 'mark', name: 'test' }]);
    Object.defineProperty(global, 'performance', {
      configurable: true,
      value: { getEntriesByType },
      writable: true,
    });

    applyPerformanceObserverPolyfill();

    expect(global.performance.getEntriesByType('resource')).toEqual([]);
    expect(getEntriesByType).not.toHaveBeenCalledWith('resource');
  });

  it('delegates non-resource timing lookups to the original implementation', () => {
    const markEntry = { entryType: 'mark', name: 'test' };
    const getEntriesByType = jest.fn(() => [markEntry]);
    Object.defineProperty(global, 'performance', {
      configurable: true,
      value: { getEntriesByType },
      writable: true,
    });

    applyPerformanceObserverPolyfill();

    expect(global.performance.getEntriesByType('mark')).toEqual([markEntry]);
    expect(getEntriesByType).toHaveBeenCalledWith('mark');
  });
});
