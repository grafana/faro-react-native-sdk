import type { IResourceSpans } from '@opentelemetry/otlp-transformer/build/src/trace/internal-types';

import { initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { Config, EventEvent } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { sendFaroEvents as send } from './faroTraceExporter.utils';

function fixture(
  paths = ['/same'],
  scopeName = '@opentelemetry/instrumentation-fetch',
  status: string | null = '200',
  extra: Record<string, string> = {}
): IResourceSpans[] {
  return [
    {
      scopeSpans: [
        {
          scope: { name: scopeName },
          spans: paths.map((path, i) => ({
            kind: 3,
            traceId: 'trace',
            spanId: String(i),
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '1001000000',
            attributes: Object.entries({
              'http.request.method': 'GET',
              'url.full': 'https://example.com' + path,
              ...(status === null ? {} : { 'http.response.status_code': status }),
              'server.address': 'example.com',
              ...extra,
            }).map(([key, value]) => ({ key, value: { stringValue: value } })),
          })),
        },
      ],
    },
  ] as unknown as IResourceSpans[];
}

describe('span-derived event pipeline', () => {
  function setup(beforeSend?: Config['beforeSend']) {
    const transport = new MockTransport();
    const faro = initializeFaro(
      mockConfig({ transports: [transport], dedupe: true, ...(beforeSend ? { beforeSend } : {}) })
    );
    const events = () =>
      transport.items.filter((item) => item.type === TransportItemType.EVENT).map((item) => item.payload as EventEvent);
    return { transport, faro, events };
  }
  it('keeps payment-failed, fetch, payment-failed', () => {
    const { faro, events } = setup();
    faro.api.pushEvent('payment-failed');
    send(fixture());
    faro.api.pushEvent('payment-failed');
    expect(events().map((e) => e.name)).toEqual(['payment-failed', 'faro.tracing.fetch', 'payment-failed']);
  });
  it('keeps fetch, other event, identical fetch', () => {
    const { faro, events } = setup();
    send(fixture());
    faro.api.pushEvent('other-event');
    send(fixture());
    expect(events().map((e) => e.name)).toEqual(['faro.tracing.fetch', 'other-event', 'faro.tracing.fetch']);
  });
  it('continues after a throwing beforeSend hook', () => {
    const { events } = setup((item) => {
      if (
        item.type === TransportItemType.EVENT &&
        (item.payload as EventEvent).attributes?.['http.url'] === 'https://example.com/first'
      )
        throw new Error('test hook failure');
      return item;
    });
    send(fixture(['/first', '/second', '/third']));
    expect(events().map((e) => e.attributes?.['http.url'])).toEqual([
      'https://example.com/second',
      'https://example.com/third',
    ]);
  });
  it('continues after a throwing transport', () => {
    const { transport, events } = setup();
    const originalSend = transport.send.bind(transport);
    let first = true;
    transport.send = (...args: Parameters<typeof transport.send>) => {
      if (first) {
        first = false;
        throw new Error('test transport failure');
      }
      return originalSend(...args);
    };
    send(fixture(['/first', '/second', '/third']));
    expect(events().map((e) => e.attributes?.['http.url'])).toEqual([
      'https://example.com/second',
      'https://example.com/third',
    ]);
  });
  it.each(['200', '500'])('maps stable XHR span attributes to legacy event fields (%s)', (status) => {
    const { events } = setup();
    send(fixture(['/xhr'], '@opentelemetry/instrumentation-xml-http-request', status));
    const [event] = events();
    expect(event?.name).toBe('faro.tracing.xml-http-request');
    expect(event?.attributes).toMatchObject({
      'http.method': 'GET',
      'http.url': 'https://example.com/xhr',
      'http.status_code': status,
      'http.host': 'example.com',
      'http.scheme': 'https',
    });
    expect(event?.attributes?.['url.full']).toBeUndefined();
    expect(event?.attributes?.['http.request.method']).toBeUndefined();
    expect(event?.attributes?.['http.response.status_code']).toBeUndefined();
    expect(event?.attributes?.['server.address']).toBeUndefined();
    expect(event?.attributes?.['component']).toBeUndefined();
  });
  it.each([
    ['error', { 'error.type': 'error' }],
    ['timeout', { 'error.type': 'timeout' }],
    ['abort', {}],
  ])('reports XHR %s without a response as status 0', (_, extra) => {
    const { events } = setup();
    send(fixture(['/xhr'], '@opentelemetry/instrumentation-xml-http-request', null, extra));
    const [event] = events();
    expect(event?.attributes?.['http.status_code']).toBe('0');
    expect(event?.attributes?.['http.url']).toBe('https://example.com/xhr');
  });
  it('does not invent a status for fetch events', () => {
    const { events } = setup();
    send(fixture(['/fetch'], '@opentelemetry/instrumentation-fetch', null, { 'error.type': 'TypeError' }));
    expect(events()[0]?.attributes?.['http.status_code']).toBeUndefined();
  });
  it('keeps legacy attributes from an older XHR instrumentation unchanged', () => {
    const { events } = setup();
    const legacy = [
      {
        scopeSpans: [
          {
            scope: { name: '@opentelemetry/instrumentation-xml-http-request' },
            spans: [
              {
                kind: 3,
                traceId: 'trace',
                spanId: 'legacy',
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '1001000000',
                attributes: Object.entries({
                  'http.method': 'POST',
                  'http.url': 'https://example.com/legacy',
                  'http.status_code': '201',
                  'http.host': 'example.com',
                  'http.scheme': 'https',
                  'http.user_agent': 'agent',
                }).map(([key, value]) => ({ key, value: { stringValue: value } })),
              },
            ],
          },
        ],
      },
    ] as unknown as IResourceSpans[];
    send(legacy);
    expect(events()[0]?.attributes).toMatchObject({
      'http.method': 'POST',
      'http.url': 'https://example.com/legacy',
      'http.status_code': '201',
      'http.host': 'example.com',
      'http.scheme': 'https',
      'http.user_agent': 'agent',
    });
  });
});
