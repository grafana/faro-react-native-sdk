import type { TransportItem } from '@grafana/faro-core';

export interface FetchTransportRequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  headers?: Record<string, string>;
}

export interface FetchTransportOptions {
  // url of the collector endpoint
  url: string;

  // will be added as `x-api-key` header
  apiKey?: string;
  // how many requests to buffer in total
  bufferSize?: number;
  // how many requests to execute concurrently
  concurrency?: number;
  // if rate limit response does not include a Retry-After header,
  // how many milliseconds to back off before attempting a request.
  // intermediate events will be dropped, not buffered
  defaultRateLimitBackoffMs?: number;
  // get current date. for mocking purposes in tests
  getNow?: ClockFn;
  // addition options for global.Fetch
  requestOptions?: FetchTransportRequestOptions;
}

export type ClockFn = () => number;

export type FetchTransportSendOutcome = 'accepted' | 'rejected' | 'failed' | 'skipped';

export interface FetchTransportSendResult {
  outcome: FetchTransportSendOutcome;
  status?: number;
}

/**
 * Where a `FetchTransport` hands live items it could not deliver. Implemented
 * by `OfflineTransport`.
 *
 * @internal
 */
export interface FetchTransportOfflineStore {
  /** True to store items without a request: the device is known to be offline. */
  isOffline(): boolean;
  /** Stores items for a later retry, as one cache entry, in the order of the calls. */
  store(items: TransportItem[]): void;
  /** Called when a live request was accepted: the collector is reachable. */
  delivered(): void;
  /** True while the owner is bound to a Faro instance and not disposed; another owner does not replace it then. */
  isBound(): boolean;
}
