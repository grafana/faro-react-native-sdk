import { type EventEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { XHRInstrumentation } from './index';

const FARO_TRACING_FETCH_EVENT = 'faro.tracing.fetch';

describe('XHRInstrumentation', () => {
  let prototypeSend: typeof XMLHttpRequest.prototype.send;
  let prototypeOpen: typeof XMLHttpRequest.prototype.open;

  beforeAll(() => {
    prototypeSend = XMLHttpRequest.prototype.send;
    prototypeOpen = XMLHttpRequest.prototype.open;
  });

  afterEach(() => {
    XMLHttpRequest.prototype.send = prototypeSend;
    XMLHttpRequest.prototype.open = prototypeOpen;
  });

  it('should have correct name and version', () => {
    const instrumentation = new XHRInstrumentation();
    expect(instrumentation.name).toBe('@grafana/faro-react-native:instrumentation-xhr');
    expect(typeof instrumentation.version).toBe('string');
  });

  it('should patch XMLHttpRequest.prototype when initialized', () => {
    const transport = new MockTransport();
    const originalSend = XMLHttpRequest.prototype.send;
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new XHRInstrumentation()],
      })
    );
    expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);
  });

  it('should track XHR requests and emit faro.tracing.fetch event', (done) => {
    const transport = new MockTransport();
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new XHRInstrumentation()],
      })
    );

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/test');
    xhr.onreadystatechange = function () {
      if (this.readyState === 4) {
        const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
        const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);
        expect(fetchEvent).toBeDefined();
        expect(fetchEvent?.payload.attributes?.['http.url']).toBe('https://api.example.com/test');
        expect(fetchEvent?.payload.attributes?.['http.method']).toBe('GET');
        done();
      }
    };
    xhr.onerror = () => done();
    xhr.send();
  });

  it('should ignore collector URLs', (done) => {
    const transport = new MockTransport();
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new XHRInstrumentation()],
      })
    );

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://collector.grafana.net/collect/abc');
    xhr.onreadystatechange = function () {
      if (this.readyState === 4) {
        const events = transport.items.filter((item) => item.type === 'event');
        expect(events.length).toBe(0);
        done();
      }
    };
    xhr.onerror = () => done();
    xhr.send();
  });
});
