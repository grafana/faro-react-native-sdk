export interface HttpRequestMessagePayload {
  requestId: string;
  url: string;
  method: string;
  startTime: number;
  endTime?: number;
  status?: number;
}

// Declare global HTTP monitor interface
declare global {
  var __FARO_HTTP_MONITOR__:
    | {
        notifyStart?: (request: HttpRequestMessagePayload) => void;
        notifyEnd?: (request: HttpRequestMessagePayload) => void;
      }
    | undefined;
}

import { Observable } from '@grafana/faro-core';

export type HttpRequestMessage =
  | { type: 'http_request_start'; request: HttpRequestMessagePayload }
  | { type: 'http_request_end'; request: HttpRequestMessagePayload };

type HttpRequestObservable = Observable<HttpRequestMessage>;

/**
 * Monitor for HTTP requests happening during user actions
 * Tracks fetch requests to correlate with user actions
 */
export function monitorHttpRequests(): HttpRequestObservable {
  interface GlobalWithMonitor {
    __FARO_HTTP_MONITOR__?: {
      observable: Observable<HttpRequestMessage>;
      notifyStart: (request: HttpRequestMessagePayload) => void;
      notifyEnd: (request: HttpRequestMessagePayload) => void;
    };
  }
  const global = globalThis as GlobalWithMonitor;

  if (!global.__FARO_HTTP_MONITOR__) {
    // Initialize the monitoring observable if it doesn't exist
    const observable = new Observable<HttpRequestMessage>();
    global.__FARO_HTTP_MONITOR__ = {
      observable,
      notifyStart: (request: HttpRequestMessagePayload) => {
        try {
          observable.notify({ type: 'http_request_start', request });
        } catch (_err) {
          // Ignore notification errors
        }
      },
      notifyEnd: (request: HttpRequestMessagePayload) => {
        try {
          observable.notify({ type: 'http_request_end', request });
        } catch (_err) {
          // Ignore notification errors
        }
      },
    };
  }

  return global.__FARO_HTTP_MONITOR__.observable;
}

/**
 * Notify the HTTP monitor that a request has started
 * Should be called from HttpInstrumentation
 */
export function notifyHttpRequestStart(request: HttpRequestMessagePayload): void {
  globalThis.__FARO_HTTP_MONITOR__?.notifyStart?.(request);
}

/**
 * Notify the HTTP monitor that a request has ended
 * Should be called from HttpInstrumentation
 */
export function notifyHttpRequestEnd(request: HttpRequestMessagePayload): void {
  globalThis.__FARO_HTTP_MONITOR__?.notifyEnd?.(request);
}
