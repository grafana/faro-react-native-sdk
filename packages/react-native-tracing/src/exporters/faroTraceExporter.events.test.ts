import type { IResourceSpans } from '@opentelemetry/otlp-transformer/build/src/trace/internal-types';

import { initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { Config, EventEvent } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { sendFaroEvents as send } from './faroTraceExporter.utils';

function fixture(paths = ['/same']): IResourceSpans[] {
  return [
    {
      scopeSpans: [
        {
          scope: { name: '@opentelemetry/instrumentation-fetch' },
          spans: paths.map((path, i) => ({
            kind: 3,
            traceId: 'trace',
            spanId: String(i),
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '1001000000',
            attributes: Object.entries({
              'http.method': 'GET',
              'http.url': 'https://example.com' + path,
              'http.status_code': '200',
              component: 'fetch',
              'http.host': 'example.com',
              'http.scheme': 'https',
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
});
