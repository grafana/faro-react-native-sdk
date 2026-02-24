import { BaseInstrumentation, genShortID, VERSION } from '@grafana/faro-core';

import { notifyHttpRequestEnd, notifyHttpRequestStart } from '../userActions/httpRequestMonitor';

import { buildFetchEventAttributes } from '../http/utils';
import type { HttpRequestPayload } from '../http/utils';

const FARO_TRACING_FETCH_EVENT = 'faro.tracing.fetch';

/**
 * Get request body size from XHR send argument (best-effort).
 */
function getXhrRequestSize(body: Document | XMLHttpRequestBodyInit | null | undefined): number | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return undefined;
  return undefined;
}

/**
 * Resolve URL to string (handles relative URLs - best effort).
 */
function resolveUrl(url: string | URL): string {
  if (typeof url === 'string') return url;
  return url?.href ?? '';
}

type XHRExtended = XMLHttpRequest & {
  _faroMethod?: string;
  _faroUrl?: string;
  _faroRequestId?: string;
  _faroStartTime?: number;
  _faroHandled?: boolean;
};

/**
 * XMLHttpRequest instrumentation for React Native
 *
 * Tracks XHR and axios (which uses XHR) calls and emits faro.tracing.fetch events.
 * Same format as HttpInstrumentation for Grafana HTTP insights compatibility.
 */
export class XHRInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-xhr';
  readonly version = VERSION;

  private originalOpen?: typeof XMLHttpRequest.prototype.open;
  private originalSend?: typeof XMLHttpRequest.prototype.send;
  private ignoredUrls: RegExp[];
  private requests: Map<string, HttpRequestPayload> = new Map();

  constructor(options: { ignoredUrls?: RegExp[] } = {}) {
    super();
    this.ignoredUrls = options.ignoredUrls || [];
  }

  initialize(): void {
    this.logInfo('XHR instrumentation initialized');
    this.patchXHR();
  }

  unpatch(): void {
    const proto = XMLHttpRequest.prototype;
    if (this.originalOpen) {
      proto.open = this.originalOpen;
      this.originalOpen = undefined;
    }
    if (this.originalSend) {
      proto.send = this.originalSend;
      this.originalSend = undefined;
    }
    this.requests.clear();
  }

  private isUrlIgnored(url: string): boolean {
    if (url.includes('grafana.net/collect')) return true;
    if (this.ignoredUrls.some((p) => p.test(url))) return true;
    const configIgnoreUrls = this.config?.ignoreUrls || [];
    if (
      configIgnoreUrls.some((pattern) => {
        if (typeof pattern === 'string') return url.includes(pattern);
        return pattern.test(url);
      })
    ) {
      return true;
    }
    return false;
  }

  private patchXHR(): void {
    if (this.originalOpen) return;

    const proto = XMLHttpRequest.prototype;
    const self = this;

    this.originalOpen = proto.open;
    proto.open = function (
      this: XHRExtended,
      method: string,
      url: string | URL,
      _async = true,
      _user?: string,
      _password?: string
    ): void {
      this._faroMethod = (method || 'GET').toUpperCase();
      this._faroUrl = resolveUrl(url);
      return self.originalOpen!.apply(this, [method, url, _async, _user as string, _password as string] as Parameters<
        typeof XMLHttpRequest.prototype.open
      >);
    };

    this.originalSend = proto.send;
    proto.send = function (this: XHRExtended, body?: Document | XMLHttpRequestBodyInit | null): void {
      const url = this._faroUrl ?? '';
      const method = this._faroMethod ?? 'GET';

      if (self.isUrlIgnored(url)) {
        return self.originalSend!.apply(this, [body]);
      }

      const requestId = genShortID();
      const startTime = Date.now();
      const requestSize = getXhrRequestSize(body);

      const payload: HttpRequestPayload = {
        url,
        method,
        requestId,
        startTime,
        requestSize,
      };
      self.requests.set(requestId, payload);
      this._faroRequestId = requestId;
      this._faroStartTime = startTime;
      this._faroHandled = false;

      notifyHttpRequestStart(payload);

      const handleComplete = (): void => {
        if (this._faroHandled) return;
        this._faroHandled = true;

        const endTime = Date.now();
        const duration = endTime - (this._faroStartTime ?? startTime);
        const status = this.status;
        const contentLength = this.getResponseHeader?.('content-length');
        const responseSize =
          contentLength != null
            ? (() => {
                const n = parseInt(contentLength, 10);
                return !Number.isNaN(n) && n >= 0 ? n : undefined;
              })()
            : undefined;

        payload.endTime = endTime;
        payload.duration = duration;
        payload.status = status;
        payload.responseSize = responseSize;

        if (this.status === 0) {
          payload.error = this.statusText || 'Network request failed';
        }

        notifyHttpRequestEnd(payload);

        const attributes = buildFetchEventAttributes(payload);
        self.api?.pushEvent(FARO_TRACING_FETCH_EVENT, attributes);

        self.logDebug(
          `XHR request → ${method} ${url} | status=${status} duration=${duration}ms` +
            (requestSize != null ? ` request_size=${requestSize}` : '') +
            (payload.responseSize != null ? ` response_size=${payload.responseSize}` : '')
        );

        self.requests.delete(requestId);
      };

      const originalOnReadyStateChange = this.onreadystatechange;
      this.onreadystatechange = function (this: XMLHttpRequest, ev: Event): void {
        if (this.readyState === 4) {
          handleComplete.call(this);
        }
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.call(this, ev);
        }
      };

      this.addEventListener('load', handleComplete);
      this.addEventListener(
        'error',
        function (this: XHRExtended) {
          if (!this._faroHandled) {
            payload.error = 'Network request failed';
            handleComplete.call(this);
          }
        }.bind(this)
      );
      this.addEventListener(
        'abort',
        function (this: XHRExtended) {
          if (!this._faroHandled) {
            payload.error = 'Request aborted';
            payload.status = 0;
            handleComplete.call(this);
          }
        }.bind(this)
      );

      return self.originalSend!.apply(this, [body]);
    };
  }
}
