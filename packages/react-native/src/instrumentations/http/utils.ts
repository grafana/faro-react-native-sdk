export interface HttpRequestPayload {
  url: string;
  method: string;
  requestId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status?: number;
  error?: string;
  requestSize?: number;
  responseSize?: number;
}

/**
 * Parse URL for scheme and host. Returns empty strings if parsing fails.
 */
export function parseUrlParts(url: string): { scheme: string; host: string } {
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
export function buildFetchEventAttributes(payload: HttpRequestPayload): Record<string, string> {
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
