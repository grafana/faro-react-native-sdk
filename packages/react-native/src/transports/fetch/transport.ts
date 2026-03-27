import { BaseTransport, createPromiseBuffer, getTransportBody, VERSION } from '@grafana/faro-core';
import type { Patterns, PromiseBuffer, TransportItem } from '@grafana/faro-core';

import type { FetchTransportOptions } from './types';

const DEFAULT_BUFFER_SIZE = 30;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_BACKOFF_MS = 30000; // 30 seconds

const TOO_MANY_REQUESTS = 429;
const ACCEPTED = 202;

export class FetchTransport extends BaseTransport {
  readonly name = '@grafana/faro-react-native:transport-fetch';
  readonly version = VERSION;

  promiseBuffer: PromiseBuffer<Response | void>;

  private readonly rateLimitBackoffMs: number;
  private readonly getNow: () => number;
  private disabledUntil: Date;
  private consecutiveFailures: number = 0;
  private sessionReadyPromise: Promise<void> | null = null;
  private sessionReadyResolve: (() => void) | null = null;
  private sessionReady: boolean = false;
  private metasListenerRegistered: boolean = false;

  constructor(private options: FetchTransportOptions) {
    super();

    this.rateLimitBackoffMs = options.defaultRateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.getNow = options.getNow ?? (() => Date.now());
    // Align with getNow so tests (and apps) that supply a clock do not see spurious backoff
    this.disabledUntil = new Date(this.getNow());

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

  async send(items: TransportItem[]): Promise<void> {
    // DEBUG: Log at the very start of send
    this.logDebug(`FetchTransport.send() called with ${items.length} items`);

    try {
      const now = new Date(this.getNow());

      // Check if we're in backoff period
      if (this.disabledUntil > now) {
        this.logDebug(`FetchTransport: in backoff period until ${this.disabledUntil}`);
        return Promise.resolve();
      }

      // Wait for session to be ready before sending
      // This prevents 400 errors from missing X-Faro-Session-Id header
      await this.waitForSession();

      await this.promiseBuffer.add(() => {
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

        let sessionId;
        const sessionMeta = this.metas.value.session;
        if (sessionMeta != null) {
          sessionId = sessionMeta.id;
        }

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
              this.disabledUntil = this.getRetryAfterDate(response);
              this.logDebug(`FetchTransport: rate limited, disabled until ${this.disabledUntil}`);
            }

            // Log non-success responses for debugging
            if (response.status !== ACCEPTED && response.status !== 200) {
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
              this.disabledUntil = new Date(this.getNow() + FAILURE_BACKOFF_MS);
              // Reset counter so we can try again after backoff
              this.consecutiveFailures = 0;
              this.logDebug(`FetchTransport: circuit breaker activated, disabled for 30s`);
            }

            // Do NOT log errors to console - this causes infinite loops in React Native
            // when the DevTools console override intercepts even unpatchedConsole calls
          });
      });
    } catch {
      // Buffer full error - Do NOT log to console as it creates infinite loops
      // The error is typically "Task buffer full" when the device is offline
    }
  }

  override getIgnoreUrls(): Patterns {
    return ([this.options.url] as Patterns).concat(this.config.ignoreUrls ?? []);
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
