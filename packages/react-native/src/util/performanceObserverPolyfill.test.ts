import { Platform } from 'react-native';

import { applyPerformanceObserverPolyfill, isResourceObserverRaceAffected } from './performanceObserverPolyfill';

type Callback = (list: unknown, observer: unknown, options?: unknown) => void;

/**
 * Mirrors the option-shape checks React Native's PerformanceObserver runs before it creates or
 * updates a native observer (mode checks across calls are not mirrored).
 */
function validateObserveOptions(options: unknown): void {
  const { type, entryTypes, durationThreshold } = options as {
    type?: unknown;
    entryTypes?: unknown;
    durationThreshold?: unknown;
  };

  if (!type && !entryTypes) {
    throw new TypeError('must include either entryTypes or type');
  }
  if (entryTypes && type) {
    throw new TypeError('must not include both entryTypes and type');
  }
  if (entryTypes && durationThreshold != null) {
    throw new TypeError('must not include both entryTypes and durationThreshold');
  }
}

/**
 * Minimal stand-in for React Native's JS PerformanceObserver: the native observer is only
 * created on the first observe() call, and the callback receives `this`.
 */
function createFakeNativePerformanceObserver() {
  const nativeCalls = {
    createObserver: 0,
    observe: [] as unknown[],
    observeAttempts: [] as unknown[],
    disconnect: 0,
    takeRecords: 0,
  };

  class PerformanceObserver {
    static supportedEntryTypes: readonly string[] = Object.freeze(['event', 'longtask', 'mark', 'measure', 'resource']);

    callback: Callback;
    nativeHandle: { emit: (entries: unknown[]) => void } | null = null;

    constructor(callback: Callback) {
      this.callback = callback;
    }

    observe(options: unknown): void {
      nativeCalls.observeAttempts.push(options);
      validateObserveOptions(options);
      if (this.nativeHandle == null) {
        nativeCalls.createObserver++;
        this.nativeHandle = { emit: (entries) => this.callback({ getEntries: () => entries }, this, {}) };
      }
      nativeCalls.observe.push(options);
    }

    disconnect(): void {
      if (this.nativeHandle == null) {
        return;
      }
      nativeCalls.disconnect++;
    }

    takeRecords(): unknown[] {
      if (this.nativeHandle == null) {
        return [];
      }
      nativeCalls.takeRecords++;
      return [{ entryType: 'mark', name: 'taken' }];
    }
  }

  return { PerformanceObserver, nativeCalls };
}

type FakeNative = ReturnType<typeof createFakeNativePerformanceObserver>;
type GuardedObserver = InstanceType<FakeNative['PerformanceObserver']>;

describe('applyPerformanceObserverPolyfill', () => {
  const originalPerformance = global.performance;
  const originalPerformanceObserver = global.PerformanceObserver;
  const originalOS = Platform.OS;
  const originalConstants = Platform.constants;

  function setPlatform(os: string, reactNativeVersion?: unknown): void {
    (Platform as { OS: string }).OS = os;
    Object.defineProperty(Platform, 'constants', {
      configurable: true,
      value: { ...originalConstants, reactNativeVersion },
      writable: true,
    });
  }

  function installFakeNative(): FakeNative {
    const fake = createFakeNativePerformanceObserver();
    Object.defineProperty(global, 'PerformanceObserver', {
      configurable: true,
      value: fake.PerformanceObserver,
      writable: true,
    });
    return fake;
  }

  function currentObserverClass(): FakeNative['PerformanceObserver'] {
    return (global as unknown as { PerformanceObserver: FakeNative['PerformanceObserver'] }).PerformanceObserver;
  }

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
    (Platform as { OS: string }).OS = originalOS;
    Object.defineProperty(Platform, 'constants', {
      configurable: true,
      value: originalConstants,
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

  describe('on Android with an affected React Native version', () => {
    let fake: FakeNative;
    let Guarded: FakeNative['PerformanceObserver'];

    beforeEach(() => {
      setPlatform('android', { major: 0, minor: 85, patch: 2, prerelease: null });
      fake = installFakeNative();
      applyPerformanceObserverPolyfill();
      Guarded = currentObserverClass();
    });

    it('wraps the global and keeps it a constructor related to the native class', () => {
      expect(Guarded).not.toBe(fake.PerformanceObserver);
      expect(typeof Guarded).toBe('function');
      expect(Guarded.name).toBe('PerformanceObserver');

      const observer = new Guarded(jest.fn());
      expect(observer).toBeInstanceOf(Guarded);
      expect(observer).toBeInstanceOf(fake.PerformanceObserver);
    });

    it('does not register a native observer for observe({ type: "resource" })', () => {
      const observer = new Guarded(jest.fn());

      observer.observe({ type: 'resource', buffered: true });

      expect(fake.nativeCalls.createObserver).toBe(0);
      expect(fake.nativeCalls.observe).toEqual([]);
    });

    it('does not register a native observer for observe({ entryTypes: ["resource"] })', () => {
      const observer = new Guarded(jest.fn());

      observer.observe({ entryTypes: ['resource'] });

      expect(fake.nativeCalls.createObserver).toBe(0);
      expect(fake.nativeCalls.observe).toEqual([]);
    });

    it('keeps non-resource types from a mixed entryTypes list', () => {
      const observer = new Guarded(jest.fn());

      observer.observe({ entryTypes: ['resource', 'mark', 'measure'] });

      expect(fake.nativeCalls.observe).toEqual([{ entryTypes: ['mark', 'measure'] }]);
    });

    it('passes single non-resource types through with all options', () => {
      const observer = new Guarded(jest.fn());
      const options = { type: 'event', buffered: true, durationThreshold: 16 };

      observer.observe(options);

      expect(fake.nativeCalls.observe).toEqual([options]);
    });

    it('preserves other options when stripping resource from entryTypes', () => {
      const observer = new Guarded(jest.fn());

      observer.observe({ entryTypes: ['mark', 'resource'], buffered: true } as never);

      expect(fake.nativeCalls.observe).toEqual([{ entryTypes: ['mark'], buffered: true }]);
    });

    it('passes repeated non-resource observe() calls to one native observer', () => {
      const observer = new Guarded(jest.fn());

      observer.observe({ type: 'mark' });
      observer.observe({ type: 'resource' });
      observer.observe({ type: 'measure', buffered: true });

      expect(fake.nativeCalls.createObserver).toBe(1);
      expect(fake.nativeCalls.observe).toEqual([{ type: 'mark' }, { type: 'measure', buffered: true }]);
    });

    it('excludes resource from supportedEntryTypes', () => {
      expect(Guarded.supportedEntryTypes).toEqual(['event', 'longtask', 'mark', 'measure']);
      expect(Object.isFrozen(Guarded.supportedEntryTypes)).toBe(true);
    });

    it('makes takeRecords() and disconnect() safe without a native observer', () => {
      const observer = new Guarded(jest.fn());
      observer.observe({ type: 'resource' });

      expect(observer.takeRecords()).toEqual([]);
      expect(() => observer.disconnect()).not.toThrow();
      expect(fake.nativeCalls.takeRecords).toBe(0);
      expect(fake.nativeCalls.disconnect).toBe(0);
    });

    it('delegates takeRecords() and disconnect() once a native observer exists', () => {
      const observer = new Guarded(jest.fn());
      observer.observe({ type: 'mark' });

      expect(observer.takeRecords()).toEqual([{ entryType: 'mark', name: 'taken' }]);
      observer.disconnect();

      expect(fake.nativeCalls.takeRecords).toBe(1);
      expect(fake.nativeCalls.disconnect).toBe(1);
    });

    it('passes the wrapper instance to the user callback', () => {
      const callback = jest.fn();
      const observer = new Guarded(callback) as GuardedObserver;
      observer.observe({ type: 'mark' });

      observer.nativeHandle?.emit([{ entryType: 'mark', name: 'm' }]);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]?.[1]).toBe(observer);
    });

    it('returns the same frozen supportedEntryTypes array on every read', () => {
      expect(Guarded.supportedEntryTypes).toBe(Guarded.supportedEntryTypes);
    });

    it('inherits custom static members of the native class', () => {
      (fake.PerformanceObserver as unknown as { custom: string }).custom = 'value';

      expect((Guarded as unknown as { custom: string }).custom).toBe('value');
    });

    it('does not mutate the caller options object', () => {
      const observer = new Guarded(jest.fn());
      const options = { entryTypes: ['resource', 'mark'] };

      observer.observe(options);

      expect(options).toEqual({ entryTypes: ['resource', 'mark'] });
      expect(fake.nativeCalls.observe).toEqual([{ entryTypes: ['mark'] }]);
    });

    it('passes an empty entryTypes list without resource through unchanged', () => {
      const observer = new Guarded(jest.fn());
      const options = { entryTypes: [] };

      observer.observe(options);

      expect(fake.nativeCalls.observe).toEqual([options]);
      expect(fake.nativeCalls.observe[0]).toBe(options);
    });

    it.each([
      ['undefined', undefined, undefined],
      ['empty object', {}, {}],
      ['type with non-resource entryTypes', { type: 'resource', entryTypes: ['mark'] }, undefined],
      [
        'type with resource-only entryTypes',
        { type: 'mark', entryTypes: ['resource'] },
        { type: 'mark', entryTypes: [] },
      ],
      [
        'type with mixed entryTypes',
        { type: 'mark', entryTypes: ['resource', 'measure'] },
        { type: 'mark', entryTypes: ['measure'] },
      ],
      [
        'resource-only entryTypes with durationThreshold',
        { entryTypes: ['resource'], durationThreshold: 16 },
        { entryTypes: [], durationThreshold: 16 },
      ],
    ])('lets native reject invalid options (%s) without registering resource', (_name, options, forwarded) => {
      const observer = new Guarded(jest.fn());

      expect(() => observer.observe(options as never)).toThrow(TypeError);

      expect(fake.nativeCalls.observeAttempts).toEqual([forwarded ?? options]);
      expect(fake.nativeCalls.createObserver).toBe(0);
      expect(fake.nativeCalls.observe).toEqual([]);
    });

    it('is idempotent', () => {
      applyPerformanceObserverPolyfill();
      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).toBe(Guarded);
      expect(Object.getPrototypeOf(Guarded)).toBe(fake.PerformanceObserver);
    });

    it('does not throw when the global PerformanceObserver is missing', () => {
      Object.defineProperty(global, 'PerformanceObserver', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      expect(() => applyPerformanceObserverPolyfill()).not.toThrow();
      expect(global.PerformanceObserver).toBeUndefined();
    });
  });

  describe('global identity by version (Android)', () => {
    it.each([
      [{ major: 0, minor: 82, patch: 1 }],
      [{ major: 0, minor: 83, patch: 5 }],
      [{ major: 0, minor: 85, patch: 3 }],
      [{ major: 0, minor: 86, patch: 0 }],
      [{ major: 0, minor: 87, patch: 0, prerelease: 'rc.1' }],
    ])('leaves the global untouched for %p', (version) => {
      setPlatform('android', version);
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).toBe(fake.PerformanceObserver);
    });

    it.each([
      ['0.83.0', { major: 0, minor: 83, patch: 0 }],
      ['missing version', undefined],
      ['malformed version', { major: 0, minor: '85', patch: 2 }],
    ])('wraps the global for %s', (_label, version) => {
      setPlatform('android', version);
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).not.toBe(fake.PerformanceObserver);
    });

    it('wraps the global when Platform.constants is missing', () => {
      (Platform as { OS: string }).OS = 'android';
      Object.defineProperty(Platform, 'constants', { configurable: true, value: undefined, writable: true });
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).not.toBe(fake.PerformanceObserver);
    });

    it('wraps the global when reading Platform.constants throws', () => {
      (Platform as { OS: string }).OS = 'android';
      Object.defineProperty(Platform, 'constants', {
        configurable: true,
        get: () => {
          throw new Error('unavailable');
        },
      });
      const fake = installFakeNative();

      expect(() => applyPerformanceObserverPolyfill()).not.toThrow();
      expect(currentObserverClass()).not.toBe(fake.PerformanceObserver);
    });
  });

  describe('global identity on other platforms', () => {
    it('wraps the global on windows with an affected version', () => {
      setPlatform('windows', { major: 0, minor: 84, patch: 1 });
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).not.toBe(fake.PerformanceObserver);
    });

    it.each([
      ['an affected version', { major: 0, minor: 85, patch: 0 }],
      ['no version', undefined],
    ])('leaves the global untouched on web with %s', (_label, version) => {
      setPlatform('web', version);
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).toBe(fake.PerformanceObserver);
    });
  });

  describe('with unusual global PerformanceObserver values on an affected version', () => {
    beforeEach(() => {
      setPlatform('android', { major: 0, minor: 85, patch: 0 });
    });

    function setGlobalObserver(value: unknown): void {
      Object.defineProperty(global, 'PerformanceObserver', { configurable: true, value, writable: true });
    }

    it('wraps a global without supportedEntryTypes and exposes an empty frozen list', () => {
      class Bare {
        observe(): void {}
        disconnect(): void {}
        takeRecords(): unknown[] {
          return [];
        }
      }
      setGlobalObserver(Bare);

      applyPerformanceObserverPolyfill();

      const Guarded = currentObserverClass();
      expect(Guarded).not.toBe(Bare);
      expect(Guarded.supportedEntryTypes).toEqual([]);
      expect(Object.isFrozen(Guarded.supportedEntryTypes)).toBe(true);
    });

    it('does not throw for a callable global that cannot be subclassed', () => {
      const callable = () => undefined;
      setGlobalObserver(callable);

      expect(() => applyPerformanceObserverPolyfill()).not.toThrow();
      expect(global.PerformanceObserver).toBe(callable);
    });

    it('does not wrap a subclass of the wrapper again', () => {
      const fake = installFakeNative();
      applyPerformanceObserverPolyfill();
      const Guarded = currentObserverClass();
      class UserSubclass extends Guarded {}
      setGlobalObserver(UserSubclass);

      applyPerformanceObserverPolyfill();

      expect(currentObserverClass()).toBe(UserSubclass);
      expect(Object.getPrototypeOf(Guarded)).toBe(fake.PerformanceObserver);
    });
  });

  describe('on iOS', () => {
    it.each([
      [{ major: 0, minor: 82, patch: 0 }],
      [{ major: 0, minor: 85, patch: 2 }],
      [{ major: 0, minor: 86, patch: 0 }],
    ])('replaces the global with a no-op observer for %p', (version) => {
      setPlatform('ios', version);
      const fake = installFakeNative();

      applyPerformanceObserverPolyfill();

      const Replaced = currentObserverClass();
      expect(Replaced.name).toBe('NoopPerformanceObserver');
      expect(Replaced.supportedEntryTypes).toEqual([]);

      const observer = new Replaced(jest.fn());
      observer.observe({ type: 'mark' });
      expect(fake.nativeCalls.observe).toEqual([]);
      expect(observer.takeRecords()).toEqual([]);

      applyPerformanceObserverPolyfill();
      expect(currentObserverClass()).toBe(Replaced);
    });
  });
});

describe('isResourceObserverRaceAffected', () => {
  it.each([
    ['0.82.0', { major: 0, minor: 82, patch: 0 }, false],
    ['0.82.1', { major: 0, minor: 82, patch: 1 }, false],
    ['0.83.0', { major: 0, minor: 83, patch: 0 }, true],
    ['0.83.4', { major: 0, minor: 83, patch: 4 }, true],
    ['0.83.5', { major: 0, minor: 83, patch: 5 }, false],
    ['0.84.0', { major: 0, minor: 84, patch: 0 }, true],
    ['0.84.1', { major: 0, minor: 84, patch: 1 }, true],
    ['0.84.9', { major: 0, minor: 84, patch: 9 }, true],
    ['0.85.0', { major: 0, minor: 85, patch: 0 }, true],
    ['0.85.2', { major: 0, minor: 85, patch: 2 }, true],
    ['0.85.3', { major: 0, minor: 85, patch: 3 }, false],
    ['0.86.0', { major: 0, minor: 86, patch: 0 }, false],
    ['0.86.1', { major: 0, minor: 86, patch: 1 }, false],
    ['1.0.0', { major: 1, minor: 0, patch: 0 }, false],
    ['1.84.0', { major: 1, minor: 84, patch: 0 }, false],
    ['0.0.0 nightly', { major: 0, minor: 0, patch: 0, prerelease: 'nightly-20260101' }, true],
    ['0.0.0 nightly hash', { major: 0, minor: 0, patch: 0, prerelease: '20260101-abcdef' }, true],
    ['0.85.0-rc.1', { major: 0, minor: 85, patch: 0, prerelease: 'rc.1' }, true],
    ['0.84.0-rc.3', { major: 0, minor: 84, patch: 0, prerelease: 'rc.3' }, true],
    ['0.83.5-rc.0', { major: 0, minor: 83, patch: 5, prerelease: 'rc.0' }, true],
    ['0.85.3-rc.0', { major: 0, minor: 85, patch: 3, prerelease: 'rc.0' }, true],
    ['0.86.0-rc.2', { major: 0, minor: 86, patch: 0, prerelease: 'rc.2' }, true],
    ['0.86.1-rc.0', { major: 0, minor: 86, patch: 1, prerelease: 'rc.0' }, false],
    ['0.82.0-rc.5', { major: 0, minor: 82, patch: 0, prerelease: 'rc.5' }, false],
    ['0.87.0-rc.1', { major: 0, minor: 87, patch: 0, prerelease: 'rc.1' }, false],
    ['1.0.0-rc.1', { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' }, false],
    ['0.85.2 with empty prerelease', { major: 0, minor: 85, patch: 2, prerelease: '' }, true],
    ['0.85.3 with empty prerelease', { major: 0, minor: 85, patch: 3, prerelease: '' }, false],
    ['0.86.0 with undefined prerelease', { major: 0, minor: 86, patch: 0, prerelease: undefined }, false],
    ['0.85.3 with null prerelease', { major: 0, minor: 85, patch: 3, prerelease: null }, false],
  ])('%s -> %p', (_label, version, expected) => {
    expect(isResourceObserverRaceAffected(version)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', '0.85.2'],
    ['missing minor', { major: 0, patch: 2 }],
    ['string parts', { major: '0', minor: '85', patch: '2' }],
    ['NaN patch', { major: 0, minor: 85, patch: Number.NaN }],
    ['fractional patch', { major: 0, minor: 85, patch: 1.5 }],
    ['negative patch', { major: 0, minor: 85, patch: -1 }],
    ['empty object', {}],
    ['numeric prerelease 0', { major: 0, minor: 86, patch: 0, prerelease: 0 }],
    ['numeric prerelease 1', { major: 0, minor: 87, patch: 0, prerelease: 1 }],
    ['object prerelease', { major: 0, minor: 87, patch: 0, prerelease: {} }],
  ])('treats a %s version as affected (fail closed)', (_label, version) => {
    expect(isResourceObserverRaceAffected(version)).toBe(true);
  });
});
