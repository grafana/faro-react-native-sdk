import { BaseInstrumentation, genShortID, VERSION } from '@grafana/faro-core';

import { notifyHttpRequestEnd, notifyHttpRequestStart } from '../userActions/httpRequestMonitor';

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
 * HTTP instrumentation for React Native
 *
 * Tracks fetch API calls to monitor HTTP requests and responses.
 * Automatically captures:
 * - Request URL, method, and timing
 * - Response status codes
 * - Request duration
 * - Request/response size (bytes; best-effort; aligned with Flutter SDK)
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

      // Track request start
      self.api?.pushMeasurement(
        {
          type: 'http_request_start',
          values: {
            timestamp: startTime,
          },
        },
        {
          context: {
            url,
            method,
            requestId,
          },
        }
      );

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

          // Build context/values aligned with Flutter (request_size, response_size as strings in context)
          const context: Record<string, string> = {
            url,
            method,
            requestId,
            statusText: response.statusText,
          };
          if (requestSize != null) context.request_size = String(requestSize);
          if (payload.responseSize != null) context.response_size = String(payload.responseSize);

          const values: Record<string, number> = {
            duration,
            status: response.status,
          };
          if (requestSize != null) values.request_size = requestSize;
          if (payload.responseSize != null) values.response_size = payload.responseSize;

          // Track successful request
          self.api?.pushMeasurement(
            {
              type: 'http_request',
              values,
            },
            { context }
          );

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

          const context: Record<string, string> = {
            url,
            method,
            requestId,
            error: payload.error || 'Unknown error',
          };
          if (requestSize != null) context.request_size = String(requestSize);

          const values: Record<string, number> = { duration };
          if (requestSize != null) values.request_size = requestSize;

          // Track failed request (no response, so no response_size)
          self.api?.pushMeasurement(
            {
              type: 'http_request_error',
              values,
            },
            { context }
          );

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
