import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

import { initializeFaro, TransportItemType, UserActionState } from '@grafana/faro-core';
import type { EventEvent, Faro, TraceEvent, UserActionInternalInterface } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { UserActionInstrumentation } from '../../react-native/src/instrumentations/userActions';
import { monitorHttpRequests } from '../../react-native/src/instrumentations/userActions/httpRequestMonitor';
import type { HttpRequestMessage } from '../../react-native/src/instrumentations/userActions/httpRequestMonitor';

import { sendFaroEvents } from './exporters/faroTraceExporter.utils';
import { TracingInstrumentation } from './instrumentation';

// Use the real RN monitor without loading native modules in jsdom.
jest.mock('@grafana/faro-react-native', () =>
  jest.requireActual('../../react-native/src/instrumentations/userActions/httpRequestMonitor')
);

const modes = [undefined, 'http', '', 'http/dup'] as const;
const url = 'https://api.example.com:8443/orders';

describe.each(modes)('fetch semantics (%s)', (mode) => {
  let faro: Faro;
  let transport: MockTransport;
  let instrumentation: TracingInstrumentation;
  let originalFetch: typeof fetch;
  let resolveResponse: (response: Response) => void;
  let messages: HttpRequestMessage[];
  let unsubscribe: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    globalThis.__FARO_HTTP_MONITOR__ = undefined;
    messages = [];
    const subscription = monitorHttpRequests().subscribe((message) => messages.push(message));
    unsubscribe = () => subscription.unsubscribe();
    transport = new MockTransport();
    transport.getIgnoreUrls = () => [/ignored/];
    faro = initializeFaro(mockConfig({ transports: [transport], dedupe: false }))!;
    faro.api.setSession({ id: 'http-session', attributes: { isSampled: 'true' } });
    instrumentation = new TracingInstrumentation({
      instrumentationOptions: {
        propagateTraceHeaderCorsUrls: [/.*/],
        fetchInstrumentationOptions: {
          ignoreNetworkEvents: true,
          ...(mode === undefined ? {} : { semconvStabilityOptIn: mode }),
        },
      },
    });
    faro.instrumentations.add(new UserActionInstrumentation(), instrumentation);
  });

  afterEach(async () => {
    await jest.advanceTimersByTimeAsync(2000);
    await instrumentation.shutdown();
    faro.instrumentations.remove(...faro.instrumentations.instrumentations);
    unsubscribe();
    globalThis.fetch = originalFetch;
    globalThis.__FARO_HTTP_MONITOR__ = undefined;
    trace.disable();
    context.disable();
    propagation.disable();
    jest.useRealTimers();
  });

  function respond(status: number) {
    resolveResponse(
      Object.assign(new Response(), { url, status, statusText: status === 200 ? 'OK' : 'Request failed' })
    );
  }

  function exported() {
    const spans = transport.items
      .filter((item) => item.type === TransportItemType.TRACE)
      .flatMap((item) => (item.payload as TraceEvent).resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans ?? []);
    const events = transport.items
      .filter((item) => item.type === TransportItemType.EVENT)
      .map((item) => item.payload as EventEvent)
      .filter((event) => event.name === 'faro.tracing.fetch');
    expect(spans).toHaveLength(1);
    expect(events).toHaveLength(1);
    return { span: spans[0]!, event: events[0]! };
  }

  it.each([
    ['GET', 200],
    ['POST', 200],
    ['POST', 401],
    ['POST', 500],
  ] as const)('exports compatible spans and events for %s %i', async (method, status) => {
    const pending = globalThis.fetch(url, { method });
    await jest.advanceTimersByTimeAsync(250);
    respond(status);
    await pending;
    await jest.advanceTimersByTimeAsync(2000);
    const { span, event } = exported();
    const stable = mode !== '';
    const legacy = mode === '' || mode === 'http/dup';
    expect(span.name).toBe(legacy ? `HTTP ${method}` : method);
    expect(span.status?.code).toBe(status >= 400 ? 2 : 0);
    const attributes = Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));
    if (stable) {
      expect(attributes).toMatchObject({
        'http.request.method': { stringValue: method },
        'url.full': { stringValue: url },
        'server.address': { stringValue: 'api.example.com' },
        'server.port': { intValue: 8443 },
        'http.response.status_code': { intValue: status },
      });
      expect(attributes['error.type']).toEqual(status >= 400 ? { stringValue: String(status) } : undefined);
      expect(span.status?.message).toBeUndefined();
    }
    if (!legacy) {
      expect(attributes['http.method']).toBeUndefined();
      expect(attributes['http.url']).toBeUndefined();
      expect(attributes['http.status_code']).toBeUndefined();
    }
    expect(event.attributes).toMatchObject({
      'http.method': method,
      'http.url': url,
      'http.status_code': String(status),
      'http.host': 'api.example.com:8443',
      'http.scheme': 'https',
      'session.id': 'http-session',
    });
    expect(event.attributes!['url.full']).toBeUndefined();
    expect(event.attributes!['http.request.method']).toBeUndefined();
    expect(event.attributes!['server.address']).toBeUndefined();
    expect(Object.values(event.attributes!).every((value) => typeof value === 'string')).toBe(true);
    expect(Number(event.attributes!['duration_ns'])).toBeGreaterThan(0);
    expect(event.trace).toEqual({ trace_id: span.traceId, span_id: span.spanId });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.request).toMatchObject({ requestId: span.spanId, url, method });
    expect(messages[1]!.request).toMatchObject({ requestId: span.spanId, url, method, status });
    expect(messages[1]!.request.startTime).toBe(messages[0]!.request.startTime);
    expect(messages[1]!.request.endTime! - messages[1]!.request.startTime).toBeCloseTo(250, 0);
  });

  it('does not classify a non-HTTP URL span as a request', async () => {
    const span = trace.getTracer('custom').startSpan('read-file', {
      kind: SpanKind.CLIENT,
      attributes: { 'url.full': 'file:///example.txt' },
    });
    span.end();
    await jest.advanceTimersByTimeAsync(2000);
    expect(messages).toEqual([]);
    const events = transport.items
      .filter((item) => item.type === TransportItemType.EVENT)
      .map((item) => item.payload as EventEvent);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'faro.tracing.custom',
          attributes: expect.objectContaining({ 'url.full': 'file:///example.txt' }),
        }),
      ])
    );
    expect(events.some((event) => event.name === 'faro.tracing.fetch')).toBe(false);
  });

  function pairs() {
    const spans = transport.items
      .filter((item) => item.type === TransportItemType.TRACE)
      .flatMap((item) => (item.payload as TraceEvent).resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans ?? []);
    const events = transport.items
      .filter((item) => item.type === TransportItemType.EVENT)
      .map((item) => item.payload as EventEvent)
      .filter((event) => event.name === 'faro.tracing.fetch');
    return spans.map((span) => ({ span, event: events.find((event) => event.trace?.span_id === span.spanId)! }));
  }

  function expectAssociation(pair: ReturnType<typeof pairs>[number], action?: UserActionInternalInterface) {
    const attributes = Object.fromEntries(pair.span.attributes.map(({ key, value }) => [key, value]));
    expect(attributes['faro.action.user.name']).toEqual(action ? { stringValue: action.name } : undefined);
    expect(attributes['faro.action.user.parentId']).toEqual(action ? { stringValue: action.parentId } : undefined);
    expect(pair.event).toBeDefined();
    expect(pair.event.action).toEqual(action ? { name: action.name, parentId: action.parentId } : undefined);
  }

  it.each(['none', 'ended', 'cancelled', 'halted'] as const)(
    'does not associate a request with an action that is %s',
    async (state) => {
      if (state !== 'none') {
        const action = faro.api.startUserAction('previous-action') as UserActionInternalInterface;
        if (state === 'ended') action.end();
        else if (state === 'cancelled') action.cancel();
        else action.halt();
      }
      const pending = globalThis.fetch(url);
      respond(200);
      await pending;
      await jest.advanceTimersByTimeAsync(2000);
      expectAssociation(exported());
    }
  );

  it('does not track excluded requests or make the action wait for them', async () => {
    const action = faro.api.startUserAction('ignored-request') as UserActionInternalInterface;
    const pending = globalThis.fetch('https://api.example.com/ignored');
    await jest.advanceTimersByTimeAsync(250);
    expect(action.getState()).toBe(UserActionState.Ended);
    expect(messages).toEqual([]);
    respond(200);
    await pending;
    await jest.advanceTimersByTimeAsync(2000);
    expect(pairs()).toEqual([]);
  });

  it.each([false, true])(
    'preserves request-start ownership at export time (earlier action: %s)',
    async (hasEarlierAction) => {
      const earlier = hasEarlierAction
        ? (faro.api.startUserAction('earlier-action') as UserActionInternalInterface)
        : undefined;
      const pending = globalThis.fetch(url);
      earlier?.end();
      respond(200);
      await pending;
      // Fetch waits 300ms for resource data, then the exporter batches for 1000ms.
      await jest.advanceTimersByTimeAsync(1250);
      const action = faro.api.startUserAction('later-action') as UserActionInternalInterface;
      await jest.advanceTimersByTimeAsync(2000);
      expect(action.getState()).toBe(UserActionState.Ended);
      expectAssociation(exported(), earlier);
    }
  );

  it.each(['paused', 'beforeSend'] as const)('respects transport filtering when %s', async (filter) => {
    if (filter === 'paused') faro.transports.pause();
    else faro.transports.addBeforeSendHooks((item) => (item.type === TransportItemType.EVENT ? null : item));
    const pending = globalThis.fetch(url);
    respond(200);
    await pending;
    await jest.advanceTimersByTimeAsync(2000);
    expect(transport.items.some((item) => item.type === TransportItemType.EVENT)).toBe(false);
  });

  it('respects fetch event deduplication and the configured event domain', async () => {
    faro.config.eventDomain = 'http-tests';
    const pending = globalThis.fetch(url);
    respond(200);
    await pending;
    await jest.advanceTimersByTimeAsync(2000);
    expect(exported().event.domain).toBe('http-tests');
    const resourceSpans = (transport.items.find((item) => item.type === TransportItemType.TRACE)!.payload as TraceEvent)
      .resourceSpans;
    faro.config.dedupe = true;
    sendFaroEvents(resourceSpans);
    expect(transport.items.filter((item) => item.type === TransportItemType.EVENT)).toHaveLength(1);
    faro.config.dedupe = false;
    sendFaroEvents(resourceSpans);
    expect(transport.items.filter((item) => item.type === TransportItemType.EVENT)).toHaveLength(2);
  });

  it('does not attach a new request to an action already waiting for another request', async () => {
    const action = faro.api.startUserAction('first-request') as UserActionInternalInterface;
    const first = globalThis.fetch(url);
    const resolveFirst = resolveResponse;
    expect(action.getState()).toBe(UserActionState.Halted);
    const second = globalThis.fetch(url);
    const resolveSecond = resolveResponse;
    resolveFirst(Object.assign(new Response(), { url, status: 200 }));
    await first;
    await jest.advanceTimersByTimeAsync(2000);
    expect(action.getState()).toBe(UserActionState.Ended);
    resolveSecond(Object.assign(new Response(), { url, status: 200 }));
    await second;
    await jest.advanceTimersByTimeAsync(2000);
    const results = pairs();
    expect(results).toHaveLength(2);
    expectAssociation(results.find(({ span }) => span.spanId === messages[0]!.request.requestId)!, action);
    expectAssociation(results.find(({ span }) => span.spanId === messages[1]!.request.requestId)!);
  });

  it('retains request ownership when a later action starts before the earlier response arrives', async () => {
    const firstAction = faro.api.startUserAction('first-action') as UserActionInternalInterface;
    const first = globalThis.fetch(url);
    const resolveFirst = resolveResponse;
    firstAction.end();
    const secondAction = faro.api.startUserAction('second-action') as UserActionInternalInterface;
    const second = globalThis.fetch(url);
    const resolveSecond = resolveResponse;
    resolveFirst(Object.assign(new Response(), { url, status: 200 }));
    await first;
    await jest.advanceTimersByTimeAsync(500);
    expect(secondAction.getState()).toBe(UserActionState.Halted);
    resolveSecond(Object.assign(new Response(), { url, status: 200 }));
    await second;
    await jest.advanceTimersByTimeAsync(2000);
    const results = pairs();
    expect(results).toHaveLength(2);
    expectAssociation(results.find(({ span }) => span.spanId === messages[0]!.request.requestId)!, firstAction);
    expectAssociation(results.find(({ span }) => span.spanId === messages[1]!.request.requestId)!, secondAction);
  });

  it('keeps a slow request associated with its action until it ends', async () => {
    const action = faro.api.startUserAction('load-orders') as UserActionInternalInterface;
    const pending = globalThis.fetch(url, { method: 'GET' });
    await jest.advanceTimersByTimeAsync(250);
    expect(action.getState()).toBe(UserActionState.Halted);
    respond(200);
    await pending;
    await jest.advanceTimersByTimeAsync(2000);
    expect(action.getState()).toBe(UserActionState.Ended);
    const { span, event } = exported();
    expect(span.attributes).toEqual(
      expect.arrayContaining([
        { key: 'faro.action.user.name', value: { stringValue: 'load-orders' } },
        { key: 'faro.action.user.parentId', value: { stringValue: action.parentId } },
      ])
    );
    expect(event.action).toEqual({ name: 'load-orders', parentId: action.parentId });
  });
});
