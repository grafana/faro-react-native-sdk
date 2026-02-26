import { type EventEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { HttpInstrumentation } from './index';

const FARO_TRACING_FETCH_EVENT = 'faro.tracing.fetch';

describe('HttpInstrumentation', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('initialization', () => {
    it('should patch global fetch', () => {
      const transport = new MockTransport();
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      expect(global.fetch).not.toBe(originalFetch);
    });

    it('should have correct name and version', () => {
      const instrumentation = new HttpInstrumentation();
      expect(instrumentation.name).toBe('@grafana/faro-react-native:instrumentation-http');
      expect(typeof instrumentation.version).toBe('string');
    });
  });

  describe('fetch tracking', () => {
    it('should track successful fetch requests with faro.tracing.fetch event', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200, statusText: 'OK' });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://api.example.com/data');

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.url']).toBe('https://api.example.com/data');
      expect(fetchEvent?.payload.attributes?.['http.method']).toBe('GET');
      expect(fetchEvent?.payload.attributes?.['http.status_code']).toBe('200');
      expect(fetchEvent?.payload.attributes?.['http.scheme']).toBe('https');
      expect(fetchEvent?.payload.attributes?.['http.host']).toBe('api.example.com');
      expect(fetchEvent?.payload.attributes?.['duration_ns']).toBeDefined();
    });

    it('should track POST requests', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 201 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://api.example.com/data', { method: 'POST' });

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.method']).toBe('POST');
      expect(fetchEvent?.payload.attributes?.['http.url']).toBe('https://api.example.com/data');
    });

    it('should track failed fetch requests with faro.tracing.fetch event', async () => {
      const transport = new MockTransport();
      const error = new Error('Network error');
      global.fetch = jest.fn().mockRejectedValue(error);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://api.example.com/data').catch(() => {});

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.status_code']).toBe('0');
      expect(fetchEvent?.payload.attributes?.['http.error']).toBe('Network error');
      expect(fetchEvent?.payload.attributes?.['duration_ns']).toBeDefined();
      // HTTP failures are tracked as events only (no pushError); Grafana FEO derives HTTP Errors from events
    });

    it('should handle URL object input', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      const url = new URL('https://api.example.com/data');
      await fetch(url);

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.url']).toBe('https://api.example.com/data');
    });

    it('should handle Request object input', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      const request = new Request('https://api.example.com/data', { method: 'POST' });
      await fetch(request);

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.url']).toBe('https://api.example.com/data');
      expect(fetchEvent?.payload.attributes?.['http.method']).toBe('POST');
    });
  });

  describe('URL filtering', () => {
    it('should ignore Grafana collector URLs', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://faro.grafana.net/collect');

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvents = events.filter((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvents).toHaveLength(0);
    });

    it('should ignore URLs matching custom patterns', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new HttpInstrumentation({
              ignoredUrls: [/localhost/, /127\.0\.0\.1/, /internal-api/],
            }),
          ],
        })
      );

      await fetch('http://localhost:3000/api');
      await fetch('http://127.0.0.1:8080/data');
      await fetch('https://api.example.com/internal-api/users');

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvents = events.filter((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvents).toHaveLength(0);
    });

    it('should track non-ignored URLs', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new HttpInstrumentation({
              ignoredUrls: [/localhost/],
            }),
          ],
        })
      );

      await fetch('https://api.example.com/data');

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvents = events.filter((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvents.length).toBeGreaterThan(0);
    });
  });

  describe('request timing', () => {
    it('should calculate request duration', async () => {
      jest.useFakeTimers();

      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
      global.fetch = jest.fn().mockReturnValue(fetchPromise);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      const request = fetch('https://api.example.com/data');

      jest.advanceTimersByTime(500);

      resolvePromise!(mockResponse);
      await request;

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent?.payload.attributes?.['duration_ns']).toBeDefined();
      expect(typeof fetchEvent?.payload.attributes?.['duration_ns']).toBe('string');

      jest.useRealTimers();
    });

    it('should track request_size and response_size when available', async () => {
      const transport = new MockTransport();
      const requestBody = JSON.stringify({ key: 'value' });
      const mockResponse = new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Length': '14' },
      });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://api.example.com/data', {
        method: 'POST',
        body: requestBody,
      });

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvent = events.find((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.payload.attributes?.['http.request_size']).toBe(String(requestBody.length));
      expect(fetchEvent?.payload.attributes?.['http.response_size']).toBe('14');
    });
  });

  describe('unpatch', () => {
    it('should restore original fetch', () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const { config } = initializeFaro(
        mockConfig({
          transports: [new MockTransport()],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      const patchedFetch = global.fetch;
      expect(patchedFetch).not.toBe(mockFetch);

      const instrumentation = config.instrumentations?.[0] as HttpInstrumentation;
      instrumentation.unpatch();

      expect(global.fetch).toBe(mockFetch);
    });

    it('should clear tracked requests', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      const mockFetch = jest.fn().mockResolvedValue(mockResponse);

      const savedFetch = global.fetch;
      global.fetch = mockFetch;

      const { config } = initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await fetch('https://api.example.com/data1');
      await fetch('https://api.example.com/data2');

      const instrumentation = config.instrumentations?.[0] as HttpInstrumentation;
      instrumentation.unpatch();

      expect(() => instrumentation.unpatch()).not.toThrow();

      global.fetch = savedFetch;
    });
  });

  describe('concurrent requests', () => {
    it('should track multiple concurrent requests', async () => {
      const transport = new MockTransport();
      const mockResponse = new Response('{}', { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new HttpInstrumentation()],
        })
      );

      await Promise.all([
        fetch('https://api.example.com/data1'),
        fetch('https://api.example.com/data2'),
        fetch('https://api.example.com/data3'),
      ]);

      const events = transport.items.filter((item) => item.type === 'event') as TransportItem<EventEvent>[];
      const fetchEvents = events.filter((e) => e.payload.name === FARO_TRACING_FETCH_EVENT);

      expect(fetchEvents).toHaveLength(3);

      const urls = fetchEvents.map((e) => e.payload.attributes?.['http.url']).sort();
      expect(urls).toContain('https://api.example.com/data1');
      expect(urls).toContain('https://api.example.com/data2');
      expect(urls).toContain('https://api.example.com/data3');
    });
  });
});
