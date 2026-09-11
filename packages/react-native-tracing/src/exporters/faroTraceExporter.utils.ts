import type { SpanContext } from '@opentelemetry/api';
import { ESpanKind, type IResourceSpans } from '@opentelemetry/otlp-transformer/build/src/trace/internal-types';

import { createInternalLogger, faro, unknownString } from '@grafana/faro-core';
import type { EventAttributes as FaroEventAttributes } from '@grafana/faro-core';

const internalLogger = createInternalLogger();

const DURATION_NS_KEY = 'duration_ns';

/** Keep Faro's fetch event contract independent of the selected OTel span schema. */
function projectFetchEventAttributes(attributes: FaroEventAttributes): void {
  const fields = {
    'http.request.method': 'http.method',
    'url.full': 'http.url',
    'http.response.status_code': 'http.status_code',
  };
  for (const [stable, legacy] of Object.entries(fields)) {
    if (attributes[stable] != null) {
      attributes[legacy] = attributes[stable];
      delete attributes[stable];
    }
  }

  const url = attributes['http.url'];
  if (url) {
    try {
      const parsed = new URL(url);
      attributes['http.host'] = attributes['http.host'] ?? parsed.host;
      attributes['http.scheme'] = attributes['http.scheme'] ?? parsed.protocol.replace(':', '');
    } catch {
      // Keep the captured URL even if it cannot supply host/scheme metadata.
    }
  }
  delete attributes['server.address'];
  delete attributes['server.port'];
  attributes['component'] = attributes['component'] ?? 'fetch';
}

/**
 * Send Faro events for CLIENT spans (HTTP requests, navigation, etc.)
 *
 * IMPORTANT: This function is called during trace export and must be careful to avoid infinite loops.
 *
 * Infinite loop prevention strategy:
 * 1. Only process SPAN_KIND_CLIENT spans (HTTP requests, etc.)
 * 2. Use faro.api.pushEvent which:
 *    - Does NOT trigger console logs if ConsoleInstrumentation is configured properly
 *    - Does NOT trigger HTTP instrumentation for collector URLs (they're ignored)
 * 3. Use internalLogger for debugging instead of console
 * 4. Never call console.log/warn/error in this function
 *
 * @param resourceSpans - OTLP resource spans from trace exporter
 */
export function sendFaroEvents(resourceSpans: IResourceSpans[] = []) {
  try {
    for (const resourceSpan of resourceSpans) {
      const { scopeSpans } = resourceSpan;

      for (const scopeSpan of scopeSpans) {
        const { scope, spans = [] } = scopeSpan;

        for (const span of spans) {
          // Only process CLIENT spans (HTTP requests, external calls)
          // This avoids processing internal spans which could cause loops
          if (span.kind !== ESpanKind.SPAN_KIND_CLIENT) {
            continue;
          }

          const spanContext: Pick<SpanContext, 'traceId' | 'spanId'> = {
            traceId: span.traceId.toString(),
            spanId: span.spanId.toString(),
          };

          const faroEventAttributes: FaroEventAttributes = {};
          for (const attribute of span.attributes) {
            faroEventAttributes[attribute.key] = String(Object.values(attribute.value)[0]);
          }

          if (scope?.name === '@opentelemetry/instrumentation-fetch') {
            projectFetchEventAttributes(faroEventAttributes);
          }

          // Add span duration in nanoseconds
          if (!Number.isNaN(span.endTimeUnixNano) && !Number.isNaN(span.startTimeUnixNano)) {
            faroEventAttributes[DURATION_NS_KEY] = String(
              Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)
            );
          }

          const index = (scope?.name ?? '').indexOf('-');
          let eventName = unknownString;

          if (scope?.name) {
            if (index === -1) {
              eventName = scope.name.split('/')[1] ?? scope.name;
            }

            if (index > -1) {
              eventName = scope?.name.substring(index + 1);
            }
          }

          // Push event to Faro
          // This should NOT cause infinite loops because:
          // 1. The collector URL is in ignoreUrls for HttpInstrumentation
          // 2. ConsoleInstrumentation won't log this event
          // 3. No console.log calls are made here
          faro.api.pushEvent(`faro.tracing.${eventName}`, faroEventAttributes, undefined, {
            spanContext,
            // Convert nanoseconds to milliseconds
            timestampOverwriteMs: Number(span.endTimeUnixNano) / 1_000_000,
            customPayloadTransformer: (payload) => {
              if (
                faroEventAttributes['faro.action.user.name'] != null &&
                faroEventAttributes['faro.action.user.parentId'] != null
              ) {
                payload.action = {
                  name: faroEventAttributes['faro.action.user.name'],
                  parentId: faroEventAttributes['faro.action.user.parentId'],
                };

                delete payload.attributes?.['faro.action.user.name'];
                delete payload.attributes?.['faro.action.user.parentId'];
              }

              return payload;
            },
          });
        }
      }
    }
  } catch (error) {
    // Only log critical errors using internal logger
    // Do NOT use console.log here as it could cause infinite loops
    internalLogger.error('sendFaroEvents: Failed to process spans', error);
  }
}
