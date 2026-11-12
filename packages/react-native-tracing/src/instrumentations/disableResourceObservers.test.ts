import { trace } from '@opentelemetry/api';
import { hrTime } from '@opentelemetry/core';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

import { disableResourceObservers } from './disableResourceObservers';
const FETCH_PREPARE_SPAN_DATA = '_prepareSpanData';
const XHR_ADD_RESOURCE_OBSERVER = '_addResourceObserver';
const FETCH_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-fetch';
const XHR_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-xml-http-request';

/**
 * Contract for the private OpenTelemetry hooks replaced by `disableResourceObservers`.
 *
 * Runs against the real, unpatched OTel classes. When an OTel upgrade renames these
 * hooks, moves observer creation elsewhere, or changes what the hooks return, these
 * tests fail so the patch is revisited instead of silently reintroducing per-request
 * resource observers.
 */

type Global = Record<string, unknown>;
const g = globalThis as unknown as Global;

interface ObserverRecord {
  observed: unknown[];
}

let observers: ObserverRecord[];
let originalPerformanceObserver: unknown;
let originalPerformanceResourceTiming: unknown;

class SpyPerformanceObserver {
  record: ObserverRecord = { observed: [] };

  constructor(_callback: unknown) {
    observers.push(this.record);
  }

  observe(init: unknown): void {
    this.record.observed.push(init);
  }

  disconnect(): void {}

  takeRecords(): unknown[] {
    return [];
  }
}

const resourceInit = { entryTypes: ['resource'] };

function ownerOf(proto: object, method: string): object | undefined {
  let owner: object | undefined;
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, method)) {
      owner = p;
    }
  }
  return owner;
}

beforeEach(() => {
  observers = [];
  originalPerformanceObserver = g['PerformanceObserver'];
  originalPerformanceResourceTiming = g['PerformanceResourceTiming'];
  g['PerformanceObserver'] = SpyPerformanceObserver;
  g['PerformanceResourceTiming'] = class {};
});

afterEach(() => {
  g['PerformanceObserver'] = originalPerformanceObserver;
  g['PerformanceResourceTiming'] = originalPerformanceResourceTiming;
});

describe('OpenTelemetry fetch instrumentation contract', () => {
  type FetchInternals = {
    instrumentationName: string;
    _prepareSpanData(spanUrl: string): Record<string, unknown>;
  };

  it('defines the hook on FetchInstrumentation itself, with one argument', () => {
    const proto = FetchInstrumentation.prototype as unknown as Record<string, unknown>;
    expect(typeof proto[FETCH_PREPARE_SPAN_DATA]).toBe('function');
    expect((proto[FETCH_PREPARE_SPAN_DATA] as (...args: unknown[]) => unknown).length).toBe(1);
    expect(ownerOf(proto, FETCH_PREPARE_SPAN_DATA)).toBe(proto);
  });

  it('uses the instrumentation name the patch matches on', () => {
    const instrumentation = new FetchInstrumentation({ enabled: false }) as unknown as FetchInternals;
    expect(instrumentation.instrumentationName).toBe(FETCH_INSTRUMENTATION_NAME);
  });

  it('creates the per-request resource observer in the hook', () => {
    const instrumentation = new FetchInstrumentation({ enabled: false }) as unknown as FetchInternals;
    const data = instrumentation._prepareSpanData('https://example.com/a');

    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([resourceInit]);
    expect(Object.keys(data).sort()).toEqual(['entries', 'observer', 'spanUrl', 'startTime']);
  });

  it('returns the replacement shape when PerformanceObserver is unavailable', () => {
    g['PerformanceObserver'] = undefined;
    const instrumentation = new FetchInstrumentation({ enabled: false }) as unknown as FetchInternals;
    const original = instrumentation._prepareSpanData('https://example.com/a');
    disableResourceObservers(instrumentation as unknown as FetchInstrumentation);
    const before = hrTime();
    const replacement = instrumentation._prepareSpanData('https://example.com/a');
    const after = hrTime();
    const nanos = (time: unknown) => {
      const [seconds, ns] = time as number[];
      return Number(seconds) * 1e9 + Number(ns);
    };
    expect(nanos(replacement['startTime'])).toBeGreaterThanOrEqual(nanos(before));
    expect(nanos(replacement['startTime'])).toBeLessThanOrEqual(nanos(after));

    expect(Object.keys(replacement).sort()).toEqual(Object.keys(original).sort());
    expect(replacement['entries']).toEqual(original['entries']);
    expect(replacement['spanUrl']).toBe(original['spanUrl']);
    expect(replacement['startTime']).toEqual([expect.any(Number), expect.any(Number)]);
    expect(original['startTime']).toEqual([expect.any(Number), expect.any(Number)]);
  });

  it('creates resource observers for traced requests only through the hook', async () => {
    const provider = new BasicTracerProvider();
    const originalFetch = g['fetch'];
    g['fetch'] = jest.fn(() => Promise.resolve(Object.assign(new Response(), { status: 200 })));
    const instrumentation = new FetchInstrumentation({ enabled: false });
    instrumentation.setTracerProvider(provider);
    const hook = jest.spyOn(
      instrumentation as unknown as Record<typeof FETCH_PREPARE_SPAN_DATA, () => unknown>,
      FETCH_PREPARE_SPAN_DATA
    );

    try {
      instrumentation.enable();
      await fetch('https://example.com/a');
      expect(hook).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(1);

      // With the hook replaced, the request path creates no observer at all.
      disableResourceObservers(instrumentation);
      await fetch('https://example.com/b');
      expect(hook).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(1);
    } finally {
      instrumentation.disable();
      g['fetch'] = originalFetch;
      await provider.shutdown();
    }
  });
});

describe('OpenTelemetry XHR instrumentation contract', () => {
  type XhrInternals = {
    instrumentationName: string;
    _addResourceObserver(xhr: unknown, spanUrl: string): void;
    _xhrMem: WeakMap<object, Record<string, unknown>>;
  };

  it('defines the hook on XMLHttpRequestInstrumentation itself, with two arguments', () => {
    const proto = XMLHttpRequestInstrumentation.prototype as unknown as Record<string, unknown>;
    expect(typeof proto[XHR_ADD_RESOURCE_OBSERVER]).toBe('function');
    expect((proto[XHR_ADD_RESOURCE_OBSERVER] as (...args: unknown[]) => unknown).length).toBe(2);
    expect(ownerOf(proto, XHR_ADD_RESOURCE_OBSERVER)).toBe(proto);
  });

  it('uses the instrumentation name the patch matches on', () => {
    const instrumentation = new XMLHttpRequestInstrumentation({ enabled: false }) as unknown as XhrInternals;
    expect(instrumentation.instrumentationName).toBe(XHR_INSTRUMENTATION_NAME);
  });

  it('creates the per-request resource observer in the hook and records it as createdResources', () => {
    const instrumentation = new XMLHttpRequestInstrumentation({ enabled: false }) as unknown as XhrInternals;
    const xhr = {};
    instrumentation._xhrMem.set(xhr, {});
    instrumentation._addResourceObserver(xhr, 'https://example.com/a');

    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([resourceInit]);
    expect(Object.keys(instrumentation._xhrMem.get(xhr)?.['createdResources'] as object).sort()).toEqual([
      'entries',
      'observer',
    ]);
  });

  it('records nothing when PerformanceObserver is unavailable, like the replacement', () => {
    g['PerformanceObserver'] = undefined;
    const instrumentation = new XMLHttpRequestInstrumentation({ enabled: false }) as unknown as XhrInternals;
    const original = {};
    const replaced = {};
    instrumentation._xhrMem.set(original, {});
    instrumentation._xhrMem.set(replaced, {});

    expect(instrumentation._addResourceObserver(original, 'https://example.com/a')).toBeUndefined();
    disableResourceObservers(instrumentation as unknown as XMLHttpRequestInstrumentation);
    expect(instrumentation._addResourceObserver(replaced, 'https://example.com/a')).toBeUndefined();
    expect(instrumentation._xhrMem.get(original)).toEqual({});
    expect(instrumentation._xhrMem.get(replaced)).toEqual({});
  });

  it('creates resource observers for traced requests only through the hook', async () => {
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    const instrumentation = new XMLHttpRequestInstrumentation({ enabled: false });
    instrumentation.setTracerProvider(provider);
    const hook = jest.spyOn(
      instrumentation as unknown as Record<typeof XHR_ADD_RESOURCE_OBSERVER, () => void>,
      XHR_ADD_RESOURCE_OBSERVER
    );

    const send = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:1/unreachable');
      xhr.send();
      xhr.abort();
    };

    try {
      instrumentation.enable();
      send();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(1);

      disableResourceObservers(instrumentation);
      send();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(1);
    } finally {
      instrumentation.disable();
      trace.disable();
      await provider.shutdown();
    }
  });
});
