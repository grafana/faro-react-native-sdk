import type { Context } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import {
  type HttpRequestMessagePayload,
  notifyHttpRequestEnd,
  notifyHttpRequestStart,
} from '@grafana/faro-react-native';

const ATTR_HTTP_METHOD = 'http.method';
const ATTR_HTTP_STATUS_CODE = 'http.status_code';
const ATTR_HTTP_URL = 'http.url';

/**
 * Get string attribute from span.
 * Handles both SDK attribute format and OTLP-style attribute values.
 */
function getAttr(span: Span | ReadableSpan, key: string): string | undefined {
  const attrs = span.attributes as Record<string, unknown> | undefined;
  if (attrs == null) return undefined;
  const raw = typeof attrs['get'] === 'function' ? (attrs as { get: (k: string) => unknown })['get'](key) : attrs[key];
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'object' && raw !== null && 'stringValue' in raw) {
    const s = String((raw as { stringValue?: string }).stringValue ?? '');
    return s.length > 0 ? s : undefined;
  }
  const str = String(raw);
  return str.length > 0 ? str : undefined;
}

/**
 * Check if a span is an HTTP span (from FetchInstrumentation).
 */
function isHttpSpan(span: Span | ReadableSpan): boolean {
  // url.full is shared by non-HTTP spans; stable HTTP spans identify their method at creation.
  return getHttpMethod(span) != null || getAttr(span, ATTR_HTTP_URL) != null;
}

function getHttpUrl(span: Span | ReadableSpan): string | undefined {
  return getAttr(span, 'url.full') ?? getAttr(span, ATTR_HTTP_URL);
}

function getHttpMethod(span: Span | ReadableSpan): string | undefined {
  return getAttr(span, 'http.request.method') ?? getAttr(span, ATTR_HTTP_METHOD);
}

/**
 * SpanProcessor that notifies httpRequestMonitor when HTTP spans start and end.
 *
 * This enables user action correlation (UserActionController halt logic) when
 * TracingInstrumentation is used instead of HttpInstrumentation.
 *
 * IMPORTANT: Must not use console or trigger any instrumentation to avoid loops.
 */
export class HttpRequestMonitorSpanProcessor implements SpanProcessor {
  constructor(private readonly processor: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    if (isHttpSpan(span)) {
      const url = getHttpUrl(span) ?? '';
      const method = getHttpMethod(span) ?? 'GET';
      const requestId = span.spanContext().spanId;
      const startTimeMs = hrTimeToMilliseconds(span.startTime);

      const payload: HttpRequestMessagePayload = {
        requestId,
        url,
        method,
        startTime: startTimeMs,
      };
      notifyHttpRequestStart(payload);
    }

    this.processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (isHttpSpan(span)) {
      const url = getHttpUrl(span) ?? '';
      const method = getHttpMethod(span) ?? 'GET';
      const requestId = span.spanContext().spanId;
      const statusAttr = getAttr(span, 'http.response.status_code') ?? getAttr(span, ATTR_HTTP_STATUS_CODE);
      const status = statusAttr != null ? parseInt(statusAttr, 10) : undefined;
      const startTimeMs = hrTimeToMilliseconds(span.startTime);
      const endTimeMs = hrTimeToMilliseconds(span.endTime);

      const payload: HttpRequestMessagePayload = {
        requestId,
        url,
        method,
        startTime: startTimeMs,
        endTime: endTimeMs,
        status: !Number.isNaN(status) ? status : undefined,
      };
      notifyHttpRequestEnd(payload);
    }

    this.processor.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.processor.shutdown();
  }
}
