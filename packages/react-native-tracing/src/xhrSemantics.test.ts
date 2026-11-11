import { context, propagation, trace } from '@opentelemetry/api';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';

import { initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { EventEvent, Faro, TraceEvent } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { TracingInstrumentation } from './instrumentation';
import { xhrCustomAttributeFunctionWithDefaults } from './instrumentations/instrumentationUtils';

// Use the real RN monitor without loading native modules in jsdom.
jest.mock('@grafana/faro-react-native', () => ({
  ...jest.requireActual('../../react-native/src/instrumentations/userActions/httpRequestMonitor'),
  ...jest.requireActual('../../react-native/src/generated/faroRNPackageMeta'),
}));

const XHR_SCOPE = '@opentelemetry/instrumentation-xml-http-request';

/**
 * Drives OpenTelemetry's XMLHttpRequest instrumentation end to end: jsdom's
 * XMLHttpRequest performs real requests against a local HTTP server, and the
 * spans and events go through the Faro exporter to a mock transport.
 */
describe.each([false, true])('XHR tracing semantics (custom=%s)', (custom) => {
  // Real network round trips plus the exporter's batch delay; Jest's 5s default is too tight.
  jest.setTimeout(20000);

  let server: Server;
  let origin: string;
  let closedOrigin: string;
  let requestHeaders: IncomingHttpHeaders[];
  let faro: Faro;
  let transport: MockTransport;
  let instrumentation: TracingInstrumentation;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requestHeaders.push(req.headers);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
      } else if (req.url === '/ok') {
        res.writeHead(200).end('ok');
      } else if (req.url === '/fail') {
        res.writeHead(500).end('fail');
      } else if (req.url === '/dav') {
        res.writeHead(207).end('multi');
      } else if (req.url === '/slow') {
        setTimeout(() => res.writeHead(200).end('late'), 2000);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A port that refuses connections, for network errors.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    closedOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const originalGetEntries = performance.getEntriesByType;
  const originalObserver = globalThis.PerformanceObserver;
  const originalResourceTiming = globalThis.PerformanceResourceTiming;
  const observe = jest.fn();
  const observer = jest.fn(() => ({ observe, disconnect: jest.fn() }));

  beforeEach(() => {
    performance.getEntriesByType = jest.fn(() => []);
    observer.mockClear();
    observe.mockClear();
    globalThis.PerformanceObserver = observer as unknown as typeof PerformanceObserver;
    globalThis.PerformanceResourceTiming = class {} as typeof PerformanceResourceTiming;
    requestHeaders = [];
    globalThis.__FARO_HTTP_MONITOR__ = undefined;
    transport = new MockTransport();
    transport.getIgnoreUrls = () => [/ignored/];
    faro = initializeFaro(mockConfig({ transports: [transport], dedupe: false }))!;
    faro.api.setSession({ id: 'xhr-session', attributes: { isSampled: 'true' } });
    instrumentation = new TracingInstrumentation({
      ...(custom
        ? {
            instrumentations: [
              [
                new XMLHttpRequestInstrumentation({
                  propagateTraceHeaderCorsUrls: [/.*/],
                  applyCustomAttributesOnSpan: xhrCustomAttributeFunctionWithDefaults(),
                }),
              ],
            ],
          }
        : {}),
      instrumentationOptions: {
        enableFetchInstrumentation: false,
        enableXhrInstrumentation: true,
        propagateTraceHeaderCorsUrls: [/.*/],
      },
    });
    faro.instrumentations.add(instrumentation);
  });

  afterEach(async () => {
    await instrumentation.shutdown();
    performance.getEntriesByType = originalGetEntries;
    globalThis.PerformanceObserver = originalObserver;
    globalThis.PerformanceResourceTiming = originalResourceTiming;
    faro.instrumentations.remove(...faro.instrumentations.instrumentations);
    globalThis.__FARO_HTTP_MONITOR__ = undefined;
    trace.disable();
    context.disable();
    propagation.disable();
    expect(observer).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  type Outcome = 'load' | 'error' | 'timeout' | 'abort';

  function send(url: string, configure?: (xhr: XMLHttpRequest) => void, method = 'GET'): Promise<Outcome> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.addEventListener('load', () => resolve('load'));
      xhr.addEventListener('error', () => resolve('error'));
      xhr.addEventListener('timeout', () => resolve('timeout'));
      xhr.addEventListener('abort', () => resolve('abort'));
      configure?.(xhr);
      xhr.send();
    });
  }

  async function exported() {
    let spans: Array<NonNullable<TraceEvent['resourceSpans']>[number]['scopeSpans'][number]['spans']> = [];
    let events: EventEvent[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      spans = transport.items
        .filter((item) => item.type === TransportItemType.TRACE)
        .flatMap((item) => (item.payload as TraceEvent).resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans)
        .filter((scope) => scope.scope?.name === XHR_SCOPE)
        .map((scope) => scope.spans);
      events = transport.items
        .filter((item) => item.type === TransportItemType.EVENT)
        .map((item) => item.payload as EventEvent)
        .filter((event) => event.name === 'faro.tracing.xml-http-request');
      if (spans.flat().length > 0 && events.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const flat = spans.flat().filter((span) => span != null);
    expect(flat).toHaveLength(1);
    expect(events).toHaveLength(1);
    const span = flat[0];
    const event = events[0];
    if (!span || !event?.attributes) {
      throw new Error('missing XHR span or event');
    }
    const attributes = Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));
    return { span, attributes, event, eventAttributes: event.attributes };
  }

  it.each([
    ['/ok', 200, 0],
    ['/fail', 500, 2],
  ] as const)('exports stable spans and legacy-shaped events for %s', async (path, status, spanStatus) => {
    expect(await send(origin + path)).toBe('load');
    const { span, attributes, event, eventAttributes } = await exported();

    expect(span.name).toBe('GET');
    expect(span.status?.code).toBe(spanStatus);
    expect(attributes).toMatchObject({
      'http.request.method': { stringValue: 'GET' },
      'url.full': { stringValue: origin + path },
      'http.response.status_code': { intValue: status },
    });
    expect(attributes['http.method']).toBeUndefined();
    expect(attributes['http.url']).toBeUndefined();
    expect(attributes['http.status_code']).toBeUndefined();

    expect(eventAttributes).toMatchObject({
      'http.method': 'GET',
      'http.url': origin + path,
      'http.status_code': String(status),
      'http.host': new URL(origin).host,
      'http.scheme': 'http',
      'session.id': 'xhr-session',
    });
    expect(eventAttributes['url.full']).toBeUndefined();
    expect(eventAttributes['http.request.method']).toBeUndefined();
    expect(eventAttributes['http.response.status_code']).toBeUndefined();
    expect(eventAttributes['server.address']).toBeUndefined();
    expect(eventAttributes['server.port']).toBeUndefined();
    expect(eventAttributes['component']).toBeUndefined();
    expect(Number(eventAttributes['duration_ns'])).toBeGreaterThan(0);
    expect(event.trace).toEqual({ trace_id: span.traceId, span_id: span.spanId });

    // Trace context is propagated to the server.
    const traceparent = requestHeaders.find((headers) => headers['traceparent'])?.['traceparent'];
    expect(traceparent).toContain(span.traceId);
  });

  it('keeps the original method of a non-standard request in the event', async () => {
    expect(await send(origin + '/dav', undefined, 'PROPFIND')).toBe('load');
    const { span, attributes, eventAttributes } = await exported();

    expect(span.name).toBe('_OTHER');
    expect(attributes).toMatchObject({
      'http.request.method': { stringValue: '_OTHER' },
      'http.request.method_original': { stringValue: 'PROPFIND' },
      'http.response.status_code': { intValue: 207 },
    });
    expect(eventAttributes['http.method']).toBe('PROPFIND');
    expect(eventAttributes['http.request.method_original']).toBeUndefined();
    expect(eventAttributes['http.status_code']).toBe('207');
  });

  it.each([
    ['network error', 'error', () => closedOrigin + '/ok', undefined, 'error'],
    [
      'timeout',
      'timeout',
      () => origin + '/slow',
      (xhr: XMLHttpRequest): void => {
        xhr.timeout = 100;
      },
      'timeout',
    ],
    [
      'abort',
      'abort',
      () => origin + '/slow',
      (xhr: XMLHttpRequest): void => {
        setTimeout(() => xhr.abort(), 100);
      },
      undefined,
    ],
  ] as const)('reports a %s as status 0', async (_, outcome, url, configure, errorType) => {
    expect(await send(url(), configure)).toBe(outcome);
    const { span, attributes, eventAttributes } = await exported();

    expect(span.status?.code).toBe(2);
    expect(attributes['http.response.status_code']).toBeUndefined();
    expect(attributes['error.type']).toEqual(errorType ? { stringValue: errorType } : undefined);
    expect(eventAttributes['http.status_code']).toBe('0');
    expect(eventAttributes['http.method']).toBe('GET');
    expect(eventAttributes['http.url']).toBe(url());
  });
});
