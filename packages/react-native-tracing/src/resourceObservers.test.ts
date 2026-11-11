import { context, propagation, trace } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import { initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { Faro, TraceEvent } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { TracingInstrumentation } from './instrumentation';

// Use the real RN monitor without loading native modules in jsdom.
jest.mock('@grafana/faro-react-native', () => ({
  ...jest.requireActual('../../react-native/src/instrumentations/userActions/httpRequestMonitor'),
  ...jest.requireActual('../../react-native/src/generated/faroRNPackageMeta'),
}));

const FETCH_SCOPE = '@opentelemetry/instrumentation-fetch';

type Global = Record<string, unknown>;
const g = globalThis as unknown as Global;

/** Every PerformanceObserver constructed, and every observe() init it received. */
let observerLog: Array<{ observed: unknown[] }>;

class SpyPerformanceObserver {
  private record = { observed: [] as unknown[] };

  constructor(_callback: unknown) {
    observerLog.push(this.record);
  }

  observe(init: unknown): void {
    this.record.observed.push(init);
  }

  disconnect(): void {}

  takeRecords(): unknown[] {
    return [];
  }
}

/**
 * Faro tracing must never register a resource PerformanceObserver: on React Native
 * 0.83.0-0.83.4, 0.84.x and 0.85.0-0.85.2 every such observer is exposed to a native
 * data race that crashes the app, and on React Native the observers yield no data.
 */
describe('OpenTelemetry resource PerformanceObservers', () => {
  jest.setTimeout(20000);

  let server: Server;
  let origin: string;
  let faro: Faro;
  let transport: MockTransport;
  let tracing: TracingInstrumentation | undefined;
  let originalFetch: unknown;
  let originalPerformanceObserver: unknown;
  let originalPerformanceResourceTiming: unknown;
  let originalBatchDelay: number;
  const ownedInstrumentations: Instrumentation[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
      } else {
        res.writeHead(req.url === '/fail' ? 500 : 200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    observerLog = [];
    originalPerformanceObserver = g['PerformanceObserver'];
    originalPerformanceResourceTiming = g['PerformanceResourceTiming'];
    g['PerformanceObserver'] = SpyPerformanceObserver;
    g['PerformanceResourceTiming'] = class {};
    originalFetch = g['fetch'];
    g['fetch'] = jest.fn((input: unknown) =>
      Promise.resolve(
        Object.assign(new Response(), {
          url: String(input),
          status: String(input).endsWith('/fail') ? 500 : 200,
        })
      )
    );
    originalBatchDelay = TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS;
    TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS = 10;
    g['__FARO_HTTP_MONITOR__'] = undefined;
    transport = new MockTransport();
    transport.getIgnoreUrls = () => [/ignored/];
    const initialized = initializeFaro(mockConfig({ transports: [transport], dedupe: false }));
    if (!initialized) {
      throw new Error('Faro not initialized');
    }
    faro = initialized;
    faro.api.setSession({ id: 'observer-session', attributes: { isSampled: 'true' } });
  });

  afterEach(async () => {
    await tracing?.shutdown();
    tracing = undefined;
    faro.instrumentations.remove(...faro.instrumentations.instrumentations);
    ownedInstrumentations.splice(0).forEach((instrumentation) => instrumentation.disable());
    TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS = originalBatchDelay;
    g['__FARO_HTTP_MONITOR__'] = undefined;
    g['fetch'] = originalFetch;
    g['PerformanceObserver'] = originalPerformanceObserver;
    g['PerformanceResourceTiming'] = originalPerformanceResourceTiming;
    trace.disable();
    context.disable();
    propagation.disable();
  });

  function addTracing(options: ConstructorParameters<typeof TracingInstrumentation>[0]): void {
    tracing = new TracingInstrumentation(options);
    faro.instrumentations.add(tracing);
  }

  async function exportedSpans(scope: string, count: number) {
    const deadline = Date.now() + 5000;
    let spans: NonNullable<TraceEvent['resourceSpans']>[number]['scopeSpans'][number]['spans'] = [];
    while (Date.now() < deadline) {
      spans = transport.items
        .filter((item) => item.type === TransportItemType.TRACE)
        .flatMap((item) => (item.payload as TraceEvent).resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans)
        .filter((scopeSpans) => scopeSpans.scope?.name === scope)
        .flatMap((scopeSpans) => scopeSpans.spans ?? []);
      if (spans.length >= count) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(spans).toHaveLength(count);
    return spans.map((span) => ({
      ...span,
      attrs: Object.fromEntries(span.attributes.map(({ key, value }) => [key, value])),
    }));
  }

  function expectNoResourceObservers(): void {
    const observedResource = observerLog.filter(({ observed }) =>
      observed.some((init) => JSON.stringify(init).includes('resource'))
    );
    expect(observedResource).toEqual([]);
    expect(observerLog).toEqual([]);
  }

  it('keeps observers disabled after Faro removes and re-adds tracing', async () => {
    addTracing({});
    const firstTracing = tracing;
    if (!firstTracing) {
      throw new Error('tracing not created');
    }
    faro.instrumentations.remove(firstTracing);
    faro.instrumentations.add(firstTracing);

    await fetch(`${origin}/ok`);
    await exportedSpans(FETCH_SCOPE, 1);
    expectNoResourceObservers();
  });

  it('covers fetch and XHR instances from another copy of the OpenTelemetry packages', () => {
    let OtherFetch: typeof FetchInstrumentation | undefined;
    let OtherXhr: typeof XMLHttpRequestInstrumentation | undefined;
    jest.isolateModules(() => {
      OtherFetch = jest.requireActual('@opentelemetry/instrumentation-fetch').FetchInstrumentation;
      OtherXhr = jest.requireActual('@opentelemetry/instrumentation-xml-http-request').XMLHttpRequestInstrumentation;
    });
    if (!OtherFetch || !OtherXhr) {
      throw new Error('isolated OpenTelemetry modules not loaded');
    }
    expect(OtherFetch).not.toBe(FetchInstrumentation);

    const otherFetch = new OtherFetch({ enabled: false });
    const otherXhr = new OtherXhr({ enabled: false });
    addTracing({ instrumentations: [otherFetch, otherXhr] });

    const fetchInternals = otherFetch as unknown as { _prepareSpanData(url: string): Record<string, unknown> };
    const xhrInternals = otherXhr as unknown as {
      _addResourceObserver(xhr: object, url: string): void;
      _xhrMem: WeakMap<object, Record<string, unknown>>;
    };
    const data = fetchInternals._prepareSpanData(`${origin}/ok`);
    const xhr = {};
    xhrInternals._xhrMem.set(xhr, {});
    xhrInternals._addResourceObserver(xhr, `${origin}/ok`);

    expect(data['observer']).toBeUndefined();
    expect(data['entries']).toEqual([]);
    expect(xhrInternals._xhrMem.get(xhr)).toEqual({});
    expectNoResourceObservers();
  });

  it('does not throw when the OpenTelemetry hooks are missing', () => {
    const debug = jest.spyOn(faro.internalLogger, 'debug').mockImplementation(() => {});
    const disable = jest.fn();
    const withoutHooks = {
      instrumentationName: FETCH_SCOPE,
      instrumentationVersion: '0.0.0',
      disable,
      enable: jest.fn(),
      getConfig: () => ({ enabled: true }),
      setConfig: jest.fn(),
      setMeterProvider: jest.fn(),
      setTracerProvider: jest.fn(),
      setLoggerProvider: jest.fn(),
    } as unknown as Instrumentation;

    expect(() => addTracing({ instrumentations: [withoutHooks] })).not.toThrow();
    expect(tracing).toBeDefined();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('faro-react-native-tracing'),
      expect.stringContaining('Could not disable OpenTelemetry resource PerformanceObservers'),
      expect.stringContaining(`${FETCH_SCOPE}#_prepareSpanData missing`)
    );
  });
  it.each([FetchInstrumentation, XMLHttpRequestInstrumentation])('overrides bound own hooks for %p', (Constructor) => {
    const hook = Constructor === FetchInstrumentation ? '_prepareSpanData' : '_addResourceObserver';
    const bound = new Constructor({ enabled: false });
    const target = bound as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = target[hook];
    if (!original) {
      throw new Error('missing upstream hook');
    }
    target[hook] = original.bind(bound);
    addTracing({ instrumentations: [bound] });
    expect(target[hook]).not.toBe(original);
    expect(target[hook]).not.toBeUndefined();
    const replacement = target[hook];
    expect(replacement?.('https://example.com')).toEqual(
      hook === '_prepareSpanData'
        ? {
            entries: [],
            spanUrl: 'https://example.com',
            startTime: [expect.any(Number), expect.any(Number)],
          }
        : undefined
    );
    expectNoResourceObservers();
  });

  it.each(['_prepareSpanData', '_addResourceObserver'])('shadows subclass override %s', (hook) => {
    const override = jest.fn(() => {
      throw new Error('subclass observer hook called');
    });
    const Constructor = hook === '_prepareSpanData' ? FetchInstrumentation : XMLHttpRequestInstrumentation;
    class CustomInstrumentation extends Constructor {}
    Object.defineProperty(CustomInstrumentation.prototype, hook, { value: override });
    const instance = new CustomInstrumentation({ enabled: false });
    addTracing({ instrumentations: [instance as unknown as Instrumentation] });
    const target = instance as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(Object.prototype.hasOwnProperty.call(instance, hook)).toBe(true);
    target[hook]?.('https://example.com');
    expect(override).not.toHaveBeenCalled();
  });

  it('logs a failed write without aborting tracing setup', () => {
    const debug = jest.spyOn(faro.internalLogger, 'debug').mockImplementation(() => {});
    const frozen = Object.freeze({
      instrumentationName: FETCH_SCOPE,
      _prepareSpanData: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn(),
      getConfig: () => ({ enabled: false }),
      setConfig: jest.fn(),
      setTracerProvider: jest.fn(),
      setMeterProvider: jest.fn(),
      setLoggerProvider: jest.fn(),
    }) as unknown as Instrumentation;
    expect(() => addTracing({ instrumentations: [frozen] })).not.toThrow();
    expect(frozen.setTracerProvider).toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('faro-react-native-tracing'),
      expect.stringContaining('Could not disable OpenTelemetry resource PerformanceObservers'),
      expect.stringContaining(`${FETCH_SCOPE}#_prepareSpanData write-failed`)
    );
  });
});
