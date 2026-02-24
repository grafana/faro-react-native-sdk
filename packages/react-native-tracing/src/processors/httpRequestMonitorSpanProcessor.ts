import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import {
  notifyHttpRequestEnd,
  notifyHttpRequestStart,
  type HttpRequestMessagePayload,
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
  const raw =
    typeof attrs['get'] === 'function'
      ? (attrs as { get: (k: string) => unknown })['get'](key)
      : attrs[key];
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
  return getAttr(span, ATTR_HTTP_URL) != null || getAttr(span, ATTR_HTTP_METHOD) != null;
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
      const url = getAttr(span, ATTR_HTTP_URL) ?? '';
      const method = getAttr(span, ATTR_HTTP_METHOD) ?? 'GET';
      const requestId = span.spanContext().spanId;
      const startTimeMs = Date.now();

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
      const url = getAttr(span, ATTR_HTTP_URL) ?? '';
      const method = getAttr(span, ATTR_HTTP_METHOD) ?? 'GET';
      const requestId = span.spanContext().spanId;
      const statusAttr = getAttr(span, ATTR_HTTP_STATUS_CODE);
      const status = statusAttr != null ? parseInt(statusAttr, 10) : undefined;
      const spanWithTime = span as ReadableSpan & {
        startTimeUnixNano?: number | bigint;
        endTimeUnixNano?: number | bigint;
      };
      const startNs = spanWithTime.startTimeUnixNano;
      const endNs = spanWithTime.endTimeUnixNano;
      const startTimeMs =
        startNs != null && !Number.isNaN(Number(startNs))
          ? Number(startNs) / 1_000_000
          : Date.now();
      const endTimeMs =
        endNs != null && !Number.isNaN(Number(endNs)) ? Number(endNs) / 1_000_000 : Date.now();

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
