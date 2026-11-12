import { existsSync } from 'fs';
import { join } from 'path';
import { Platform } from 'react-native';

/**
 * React Native's PerformanceObserver is a real ES class at runtime (Hermes), so the wrapper must be
 * constructible on top of one in every published build. The CommonJS build targets ES5, where a
 * compiled `class ... extends` calls the parent constructor with `.apply()`, which throws for an ES
 * class. Test files are transpiled too, so the native class is created with `new Function` to keep
 * it a real ES class here.
 */

type ObserverInstance = {
  observe(options: unknown): void;
  disconnect(): void;
  takeRecords(): unknown[];
  emit(entries: unknown[]): void;
};
type ObserverClass = (new (callback: (list: unknown, observer: unknown) => void) => ObserverInstance) & {
  supportedEntryTypes: readonly string[];
};
type PolyfillModule = { applyPerformanceObserverPolyfill: () => void };

function createEsClassNative(observeCalls: unknown[]): ObserverClass {
  return new Function(
    'observeCalls',
    `return class PerformanceObserver {
      static supportedEntryTypes = Object.freeze(['event', 'longtask', 'mark', 'measure', 'resource']);
      #callback;
      constructor(callback) { this.#callback = callback; }
      observe(options) { observeCalls.push(options); }
      disconnect() {}
      takeRecords() { return []; }
      emit(entries) { this.#callback({ getEntries: () => entries }, this); }
    };`
  )(observeCalls) as ObserverClass;
}

function createEsSubclass(Base: ObserverClass): ObserverClass {
  return new Function('Base', 'return class AppObserver extends Base {};')(Base) as ObserverClass;
}

const packageRoot = join(__dirname, '..', '..');
const builds: Array<{ name: string; path: string; built: boolean }> = [
  { name: 'source', path: join(packageRoot, 'src', 'util', 'performanceObserverPolyfill.ts'), built: true },
  ...['cjs', 'esm'].map((format) => {
    const path = join(packageRoot, 'dist', format, 'util', 'performanceObserverPolyfill.js');
    return { name: `dist/${format}`, path, built: existsSync(path) };
  }),
];

if (process.env['CI'] && builds.some((build) => !build.built)) {
  // CI runs `yarn build` before the tests; a missing build output must not silently skip these tests.
  throw new Error('Build output missing. Run `yarn build` before testing.');
}

describe.each(builds)('PerformanceObserver guard on an ES class native observer ($name)', ({ path, built }) => {
  const originalPerformanceObserver = global.PerformanceObserver;
  const originalOS = Platform.OS;
  const originalConstants = Platform.constants;
  const run = built ? it : it.skip;

  let observeCalls: unknown[];
  let Native: ObserverClass;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    Object.defineProperty(Platform, 'constants', {
      configurable: true,
      value: { ...originalConstants, reactNativeVersion: { major: 0, minor: 85, patch: 2, prerelease: null } },
      writable: true,
    });
    observeCalls = [];
    Native = createEsClassNative(observeCalls);
    Object.defineProperty(global, 'PerformanceObserver', { configurable: true, value: Native, writable: true });

    (require(path) as PolyfillModule).applyPerformanceObserverPolyfill();
  });

  afterEach(() => {
    Object.defineProperty(global, 'PerformanceObserver', {
      configurable: true,
      value: originalPerformanceObserver,
      writable: true,
    });
    (Platform as { OS: string }).OS = originalOS;
    Object.defineProperty(Platform, 'constants', { configurable: true, value: originalConstants, writable: true });
  });

  function guardedClass(): ObserverClass {
    return (global as unknown as { PerformanceObserver: ObserverClass }).PerformanceObserver;
  }

  run('constructs observers and keeps non-resource entry types', () => {
    const Guarded = guardedClass();
    expect(Guarded).not.toBe(Native);

    const callback = jest.fn();
    const observer = new Guarded(callback);
    observer.observe({ type: 'mark' });
    observer.observe({ entryTypes: ['resource', 'measure'] });
    observer.observe({ type: 'resource' });

    expect(observeCalls).toEqual([{ type: 'mark' }, { entryTypes: ['measure'] }]);
    expect(observer).toBeInstanceOf(Guarded);
    expect(observer).toBeInstanceOf(Native);
    expect(Guarded.supportedEntryTypes).toEqual(['event', 'longtask', 'mark', 'measure']);

    observer.emit([{ entryType: 'mark' }]);
    expect(callback).toHaveBeenCalledWith(expect.anything(), observer);
  });

  run('supports ES class subclasses of the guarded observer', () => {
    const AppObserver = createEsSubclass(guardedClass());
    const observer = new AppObserver(jest.fn());
    observer.observe({ type: 'resource' });
    observer.observe({ type: 'mark' });

    expect(observer).toBeInstanceOf(AppObserver);
    expect(observer).toBeInstanceOf(Native);
    expect(observeCalls).toEqual([{ type: 'mark' }]);
  });

  run('throws when called without new', () => {
    const Guarded = guardedClass() as unknown as (callback: unknown) => unknown;
    expect(() => Guarded(jest.fn())).toThrow(TypeError);
  });
});
