import { SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { FetchCustomAttributeFunction } from '@opentelemetry/instrumentation-fetch';
import type { XHRCustomAttributeFunction } from '@opentelemetry/instrumentation-xml-http-request';

/**
 * FetchError interface matching OpenTelemetry's internal type
 * Note: FetchError is not exported from @opentelemetry/instrumentation-fetch
 */
interface FetchError {
  status?: number;
  message: string;
}

/**
 * Set span status to ERROR when fetch fails
 *
 * This ensures that failed HTTP requests are marked as errors in traces.
 */
export function setSpanStatusOnFetchError(span: Span, error: Error | string): void {
  const message = typeof error === 'string' ? error : error.message;
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });
}

/**
 * Type guard to check if result is a FetchError
 */
function isFetchError(result: Response | FetchError): result is FetchError {
  return 'message' in result && typeof (result as FetchError).message === 'string';
}

/**
 * Custom attribute function for fetch instrumentation with defaults
 *
 * Combines user-provided custom attributes with default handling.
 *
 * @param userFunction - Optional user-provided custom attribute function
 * @returns Combined custom attribute function
 */
export function fetchCustomAttributeFunctionWithDefaults(
  userFunction?: FetchCustomAttributeFunction
): FetchCustomAttributeFunction {
  const fn: FetchCustomAttributeFunction = (
    span: Span,
    request: Request | RequestInit,
    result: Response | FetchError
  ) => {
    // Call user function first if provided
    if (userFunction) {
      userFunction(span, request, result);
    }

    // Add default error handling
    // Check if result is a FetchError
    if (isFetchError(result)) {
      setSpanStatusOnFetchError(span, result.message);
    }
  };
  return fn;
}

/**
 * Set span status to ERROR for XHR failures (status 0 or 4xx/5xx).
 */
export function setSpanStatusOnXMLHttpRequestError(span: Span, xhr: XMLHttpRequest): void {
  const status = xhr.status;
  if (status == null) return;
  if (status === 0 || (status >= 400 && status < 600)) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

/**
 * Custom attribute function for XHR instrumentation with defaults.
 */
export function xhrCustomAttributeFunctionWithDefaults(
  userFunction?: XHRCustomAttributeFunction
): XHRCustomAttributeFunction {
  return (span: Span, xhr: XMLHttpRequest) => {
    setSpanStatusOnXMLHttpRequestError(span, xhr);
    userFunction?.(span, xhr);
  };
}
