import { BaseTransport, createPromiseBuffer, getTransportBody, VERSION } from '@grafana/faro-core';
import type { Patterns, PromiseBuffer, TransportItem } from '@grafana/faro-core';

import type { FetchTransportOfflineStore, FetchTransportOptions, FetchTransportSendResult } from './types';

const DEFAULT_BUFFER_SIZE = 30;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_BACKOFF_MS = 30000; // 30 seconds

const TOO_MANY_REQUESTS = 429;
export class FetchTransport extends BaseTransport {
  readonly name = '@grafana/faro-react-native:transport-fetch';
  readonly version = VERSION;

  promiseBuffer: PromiseBuffer<Response | void>;

  private readonly rateLimitBackoffMs: number;
  private readonly getNow: () => number;
  /** End of the circuit-breaker backoff after repeated failed requests. */
  private failureBackoffUntil: number;
  /** End of the backoff after a 429 response (Retry-After). */
  private rateLimitUntil: number;
  private consecutiveFailures: number = 0;
  private sessionReadyPromise: Promise<void> | null = null;
  private sessionReadyResolve: (() => void) | null = null;
  private sessionReady: boolean = false;
  private metasListenerRegistered: boolean = false;
  private offlineStore: FetchTransportOfflineStore | null = null;

  constructor(private options: FetchTransportOptions) {
    super();

    this.rateLimitBackoffMs = options.defaultRateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.getNow = options.getNow ?? (() => Date.now());
    // Align with getNow so tests (and apps) that supply a clock do not see spurious backoff
    this.failureBackoffUntil = this.getNow();
    this.rateLimitUntil = this.getNow();

    this.promiseBuffer = createPromiseBuffer({
      size: options.bufferSize ?? DEFAULT_BUFFER_SIZE,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    });
  }

  /**
   * Register a listener for metas changes to detect when session becomes available.
   * Uses faro-core's metas listener pattern instead of polling with setTimeout.
   */
  private registerSessionListener(): void {
    if (this.metasListenerRegistered || !this.metas?.addListener) {
      return;
    }

    this.metasListenerRegistered = true;

    this.metas.addListener((meta) => {
      if (meta.session?.id && this.sessionReadyResolve) {
        this.sessionReady = true;
        this.sessionReadyResolve();
        this.sessionReadyResolve = null;
      }
    });
  }

  /**
   * Wait for session to be available before sending.
   * This prevents 400 errors from the collector due to missing X-Faro-Session-Id header.
   *
   * Only waits if session tracking is enabled. If disabled, returns immediately.
   */
  private waitForSession(): Promise<void> {
    // Only wait for session if session tracking is enabled
    const sessionTrackingEnabled = this.config?.sessionTracking?.enabled;
    if (!sessionTrackingEnabled) {
      return Promise.resolve();
    }

    // Already have session
    if (this.sessionReady) {
      return Promise.resolve();
    }

    // Check if session is now available
    const sessionMeta = this.metas?.value?.session;
    if (sessionMeta?.id) {
      this.sessionReady = true;
      return Promise.resolve();
    }

    // Return existing promise if we're already waiting
    if (this.sessionReadyPromise) {
      return this.sessionReadyPromise;
    }

    // Register listener to be notified when session becomes available
    this.registerSessionListener();

    // Create a promise that resolves when session becomes available via listener
    this.sessionReadyPromise = new Promise<void>((resolve) => {
      this.sessionReadyResolve = resolve;

      // Also check immediately in case session was set between our check and listener registration
      const sessionMeta = this.metas?.value?.session;
      if (sessionMeta?.id) {
        this.sessionReady = true;
        resolve();
        this.sessionReadyResolve = null;
      }
    });

    return this.sessionReadyPromise;
  }

  /**
   * A request carries one meta block, but faro-core groups a batch before
   * beforeSend hooks run, so a hook that changes an item's meta can leave mixed
   * metadata in one send call. Each group of items with the same final meta is
   * sent as its own request. Groups are sent one after another, so a send call
   * holds at most one request-buffer slot at a time; overlapping send calls
   * still share the buffer limit. Groups after one that starts a rate-limit or
   * failure backoff are skipped like any send during backoff.
   *
   * With an `OfflineTransport` attached, items that are not delivered (see
   * `isRetryableSendResult()`) are handed to it for a later retry instead of
   * being dropped, and items are stored without a request while it reports the
   * device offline. `sendWithResult()` never hands items to it.
   */
  async send(items: TransportItem[]): Promise<void> {
    // Read before any await: items stored without a request keep capture order.
    const store = this.offlineStore;
    if (store?.isOffline()) {
      store.store(items);
      return;
    }
    for (const group of groupItemsByMeta(items)) {
      const result = await this.sendWithResult(group);
      // A store detached or replaced meanwhile is not used; items stored elsewhere are not stored twice.
      if (store && store === this.offlineStore) {
        if (result.outcome === 'accepted') {
          store.delivered();
        } else if (isRetryableSendResult(result)) {
          store.store(group);
        }
      }
    }
  }

  /**
   * Attaches the offline store that live `send()` hands undelivered items to,
   * or detaches it with `null`. Used by `OfflineTransport`.
   *
   * @internal
   */
  setOfflineStore(store: FetchTransportOfflineStore | null): void {
    this.offlineStore = store;
  }

  /** @internal */
  getOfflineStore(): FetchTransportOfflineStore | null {
    return this.offlineStore;
  }

  /**
   * When sends are skipped until (`Date.now()`-style time; in the past when
   * not backing off).
   *
   * @internal
   */
  getBackoffUntil(): number {
    return Math.max(this.failureBackoffUntil, this.rateLimitUntil);
  }

  /**
   * Forgets earlier failed requests and ends their circuit-breaker backoff,
   * for example when the device reconnects. A rate-limit backoff is kept.
   *
   * @internal
   */
  resetFailureBackoff(): void {
    this.consecutiveFailures = 0;
    this.failureBackoffUntil = this.getNow();
  }

  /**
   * Sends items that share one meta block as one request, and reports whether
   * the collector accepted it. The request body uses the first item's meta.
   * The request header uses the live session for collector accounting. Payload
   * metadata remains independent so delayed signals can retain their original
   * session.
   */
  async sendWithResult(items: TransportItem[]): Promise<FetchTransportSendResult> {
    this.logDebug(`FetchTransport.sendWithResult() called with ${items.length} items`);

    // Paused Faro sends nothing; replay calls this directly, so it is checked here too.
    if (items.length === 0 || this.config?.paused) {
      return { outcome: 'skipped' };
    }

    try {
      // Check if we're in backoff period
      const backoffUntil = this.getBackoffUntil();
      if (backoffUntil > this.getNow()) {
        this.logDebug(`FetchTransport: in backoff period until ${new Date(backoffUntil)}`);
        return { outcome: 'skipped' };
      }

      // The collector uses the header for session validation and accounting,
      // independently of the session carried by each payload.
      await this.waitForSession();
      if (this.config?.paused) {
        return { outcome: 'skipped' };
      }
      // Without metas (not registered with Faro, only used for offline replay), use the payload session.
      const sessionId = this.metas?.value?.session?.id ?? items[0]?.meta.session?.id;

      let request: PromiseLike<Response | void>;
      // A queued request starts when a buffer slot frees up, maybe after Faro was paused
      // or an earlier request started a backoff.
      let skippedWhenStarted = false;
      try {
        request = this.promiseBuffer.add(() => {
          if (this.config?.paused || this.getBackoffUntil() > this.getNow()) {
            skippedWhenStarted = true;
            return Promise.resolve();
          }
          const transportBody = getTransportBody(items);
          const body = JSON.stringify(transportBody);

          // DEBUG: Log measurement payloads to see what's being sent
          if (transportBody.measurements && transportBody.measurements.length > 0) {
            for (const m of transportBody.measurements) {
              this.logDebug(`FetchTransport: measurement payload - type=${m.type}, values=${JSON.stringify(m.values)}`);
            }
          }

          const { url, requestOptions, apiKey } = this.options;

          const { headers, ...restOfRequestOptions } = requestOptions ?? {};

          // DEBUG: Log fetch attempt
          this.logDebug(`FetchTransport: sending ${items.length} items to ${url}`);

          // Create an AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
            this.logDebug(`FetchTransport: request timed out after 10s`);
          }, 10000);

          return fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(headers ?? {}),
              ...(apiKey ? { 'x-api-key': apiKey } : {}),
              ...(sessionId ? { 'x-faro-session-id': sessionId } : {}),
            },
            body,
            signal: controller.signal,
            // Note: React Native doesn't support keepalive
            // keepalive: body.length <= BEACON_BODY_SIZE_LIMIT,
            ...(restOfRequestOptions ?? {}),
          })
            .then(async (response) => {
              clearTimeout(timeoutId);
              // DEBUG: Log response status
              this.logDebug(`FetchTransport: response status ${response.status}`);

              // Reset failure counter on success
              this.consecutiveFailures = 0;

              if (response.status === TOO_MANY_REQUESTS) {
                this.rateLimitUntil = this.getRetryAfterDate(response).getTime();
                this.logDebug(`FetchTransport: rate limited, disabled until ${new Date(this.rateLimitUntil)}`);
              }

              // Log non-success responses for debugging
              if (response.status < 200 || response.status >= 300) {
                const text = await response.text().catch(() => '');
                this.logDebug(`FetchTransport: non-success response: ${response.status} ${text.slice(0, 200)}`);
              }

              return response;
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              // DEBUG: Log the error
              this.logDebug(`FetchTransport: fetch failed - ${error?.message || error}`);

              // Increment failure counter
              this.consecutiveFailures++;

              // After MAX_CONSECUTIVE_FAILURES, enable circuit breaker to prevent infinite loops
              if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                this.failureBackoffUntil = this.getNow() + FAILURE_BACKOFF_MS;
                // Reset counter so we can try again after backoff
                this.consecutiveFailures = 0;
                this.logDebug(`FetchTransport: circuit breaker activated, disabled for 30s`);
              }

              // Do NOT log errors to console - this causes infinite loops in React Native
              // when the DevTools console override intercepts even unpatchedConsole calls
              return undefined;
            });
        });
      } catch {
        // Buffer full - Do NOT log to console as it creates infinite loops.
        // No request was made, like during backoff.
        return { outcome: 'skipped' };
      }
      const response = await request;

      if (skippedWhenStarted) {
        return { outcome: 'skipped' };
      }
      if (!response) {
        return { outcome: 'failed' };
      }
      if (response.status >= 200 && response.status < 300) {
        return {
          outcome: 'accepted',
          status: response.status,
        };
      }
      return {
        outcome: 'rejected',
        status: response.status,
      };
    } catch {
      // The request could not be built - Do NOT log to console as it creates infinite loops
      return { outcome: 'failed' };
    }
  }

  /**
   * Identifies the collector for offline replay, which sends each cached
   * payload once per key. The key is stored with cached payloads, so it is a
   * hash of the URL: Faro collector URLs contain the app token.
   *
   * @internal
   */
  getDestinationKey(): string {
    return `fetch:${hashString(this.options.url)}`;
  }

  override getIgnoreUrls(): Patterns {
    // `config` is unset until Faro initializes this transport, for example when
    // it is only passed to `OfflineTransport.setOtherTransports()`.
    return ([this.options.url] as Patterns).concat(this.config?.ignoreUrls ?? []);
  }

  override isBatched(): boolean {
    return true;
  }

  private getRetryAfterDate(response: Response): Date {
    const now = this.getNow();
    const retryAfterHeader = response.headers.get('Retry-After');

    if (retryAfterHeader) {
      const delay = Number(retryAfterHeader);

      if (!isNaN(delay)) {
        return new Date(delay * 1000 + now);
      }

      const date = Date.parse(retryAfterHeader);

      if (!isNaN(date)) {
        return new Date(date);
      }
    }

    return new Date(now + this.rateLimitBackoffMs);
  }
}

/**
 * True when a send did not deliver the items but a later retry may: the
 * request failed or timed out, was skipped during backoff or with a full
 * request buffer, or the collector answered with a status other than 2xx or a
 * 4xx other than 408 and 429.
 *
 * @internal
 */
export function isRetryableSendResult(result: FetchTransportSendResult): boolean {
  if (result.outcome === 'accepted') {
    return false;
  }
  if (result.outcome === 'rejected') {
    return !isNonRetryableStatus(result.status);
  }
  return true;
}

/**
 * Client errors other than timeout (408) and rate limit (429) mean the
 * collector will not accept the payload on retry either.
 */
function isNonRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function groupItemsByMeta(items: TransportItem[]): TransportItem[][] {
  const groups = new Map<string, TransportItem[]>();
  for (const item of items) {
    const key = JSON.stringify(item.meta);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return Array.from(groups.values());
}

/** FNV-1a, 32 bit, as 8 hex digits. Stable across launches; the result does not contain the input. */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
