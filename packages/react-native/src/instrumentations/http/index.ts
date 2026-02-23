import { BaseInstrumentation, genShortID, VERSION } from '@grafana/faro-core';

import { notifyHttpRequestEnd, notifyHttpRequestStart } from '../userActions/httpRequestMonitor';

const FARO_TRACING_FETCH_EVENT = 'faro.tracing.fetch';

export interface HttpRequestPayload {
  url: string;
  method: string;
  requestId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status?: number;
  error?: string;
  /** Request body size in bytes (best-effort; not available for FormData/streams). */
  requestSize?: number;
  /** Response body size in bytes (from Content-Length header when present). */
  responseSize?: number;
}

/**
 * Compute request body size in bytes (best-effort).
 * FormData and ReadableStream do not expose length without consuming.
 */
function getRequestSize(body: BodyInit | null | undefined): number | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
  return undefined;
}

/**
 * Parse URL for scheme and host. Returns empty strings if parsing fails.
 */
function parseUrlParts(url: string): { scheme: string; host: string } {
  try {
    const parsed = new URL(url);
    return {
      scheme: parsed.protocol.replace(':', '') || 'http',
      host: parsed.host || '',
    };
  } catch {
    return { scheme: 'http', host: '' };
  }
}

/**
 * Build Web SDK-style event attributes for faro.tracing.fetch.
 * Aligns with Grafana HTTP insights and Frontend Observability plugin.
 */
function buildFetchEventAttributes(payload: HttpRequestPayload): Record<string, string> {
  const { scheme, host } = parseUrlParts(payload.url);
  const durationNs = payload.duration != null ? String(Math.round(payload.duration * 1_000_000)) : '';
  const statusCode = payload.status != null ? String(payload.status) : '0';

  const attrs: Record<string, string> = {
    'http.url': payload.url,
    'http.method': payload.method,
    'http.scheme': scheme,
    'http.host': host,
    'http.status_code': statusCode,
    'duration_ns': durationNs,
  };

  if (payload.requestSize != null) {
    attrs['http.request_size'] = String(payload.requestSize);
  }
  if (payload.responseSize != null) {
    attrs['http.response_size'] = String(payload.responseSize);
  }
  if (payload.error) {
    attrs['http.error'] = payload.error;
  }

  return attrs;
}

/**
 * HTTP instrumentation for React Native
 *
 * Tracks fetch API calls and emits faro.tracing.fetch events (Web SDK format).
 * Compatible with Grafana Frontend Observability HTTP insights.
 * Automatically captures:
 * - Request URL, method, and timing
 * - Response status codes (0 for network errors)
 * - Request duration
 * - Request/response size (bytes; best-effort)
 * - Network errors
 *
 * @example
 * ```tsx
 * import { initializeFaro } from '@grafana/faro-react-native';
 * import { HttpInstrumentation } from '@grafana/faro-react-native';
 *
 * initializeFaro({
 *   // ...config
 *   instrumentations: [
 *     new HttpInstrumentation({
 *       ignoredUrls: [/localhost/, /127\.0\.0\.1/],
 *     }),
 *   ],
 * });
 * ```
 */
export class HttpInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-http';
  readonly version = VERSION;

  private originalFetch?: typeof fetch;
  private ignoredUrls: RegExp[];
  private requests: Map<string, HttpRequestPayload> = new Map();

  constructor(options: { ignoredUrls?: RegExp[] } = {}) {
    super();
    this.ignoredUrls = options.ignoredUrls || [];
  }

  initialize(): void {
    this.logInfo('HTTP instrumentation initialized');
    this.patchFetch();
  }

  unpatch(): void {
    if (this.originalFetch) {
      global.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
    this.requests.clear();
  }

  private isUrlIgnored(url: string): boolean {
    // Ignore the Faro collector URL to avoid tracking our own telemetry
    if (url.includes('grafana.net/collect')) {
      return true;
    }

    // Check user-provided ignored URLs
    if (this.ignoredUrls.some((pattern) => pattern.test(url))) {
      return true;
    }

    // Check config ignore URLs (includes transport URLs)
    const configIgnoreUrls = this.config?.ignoreUrls || [];
    if (
      configIgnoreUrls.some((pattern) => {
        if (typeof pattern === 'string') {
          return url.includes(pattern);
        }
        return pattern.test(url);
      })
    ) {
      return true;
    }

    return false;
  }

  private patchFetch(): void {
    if (this.originalFetch) {
      return; // Already patched
    }

    this.originalFetch = global.fetch;
    const self = this;

    global.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url || '';
      // Extract method from Request object or init options
      const requestMethod = typeof input !== 'string' && !(input instanceof URL) ? input.method : undefined;
      const method = (init?.method || requestMethod || 'GET').toUpperCase();

      if (self.isUrlIgnored(url)) {
        return self.originalFetch!.call(this, input, init);
      }

      const requestId = genShortID();
      const startTime = Date.now();
      const body = init?.body;
      const requestSize = getRequestSize(body);

      const payload: HttpRequestPayload = {
        url,
        method,
        requestId,
        startTime,
        requestSize,
      };

      self.requests.set(requestId, payload);

      // Notify user action monitor
      notifyHttpRequestStart(payload);

      return self
        .originalFetch!.call(this, input, init)
        .then((response) => {
          const endTime = Date.now();
          const duration = endTime - startTime;
          const contentLength = response.headers.get('content-length');
          const responseSize = contentLength ? parseInt(contentLength, 10) : undefined;
          payload.responseSize =
            responseSize != null && !Number.isNaN(responseSize) && responseSize >= 0
              ? responseSize
              : undefined;

          payload.endTime = endTime;
          payload.duration = duration;
          payload.status = response.status;

          // Notify user action monitor
          notifyHttpRequestEnd(payload);

          // Emit faro.tracing.fetch event (Web SDK format for Grafana HTTP insights)
          const attributes = buildFetchEventAttributes(payload);
          self.api?.pushEvent(FARO_TRACING_FETCH_EVENT, attributes);

          self.logDebug(
            `HTTP request → ${method} ${url} | status=${response.status} duration=${duration}ms` +
              (requestSize != null ? ` request_size=${requestSize}` : '') +
              (payload.responseSize != null ? ` response_size=${payload.responseSize}` : '')
          );

          self.requests.delete(requestId);
          return response;
        })
        .catch((error) => {
          const endTime = Date.now();
          const duration = endTime - startTime;

          payload.endTime = endTime;
          payload.duration = duration;
          payload.error = error?.message || 'Unknown error';

          // Notify user action monitor
          notifyHttpRequestEnd(payload);

          // Emit faro.tracing.fetch event for failed request (status 0 = network error)
          const attributes = buildFetchEventAttributes(payload);
          self.api?.pushEvent(FARO_TRACING_FETCH_EVENT, attributes);

          self.logDebug(
            `HTTP request error → ${method} ${url} | error=${payload.error} duration=${duration}ms` +
              (requestSize != null ? ` request_size=${requestSize}` : '')
          );

          self.api?.pushError(error, {
            type: 'HTTP Request Failed',
            context: {
              url,
              method,
              requestId,
              duration: String(duration),
            },
          });

          self.requests.delete(requestId);
          throw error;
        });
    };
  }
}
