import { AppState } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';

import { BaseTransport, defaultUnpatchedConsole, getTransportBody, VERSION } from '@grafana/faro-core';
import type { Patterns, Transport, TransportItem, Transports } from '@grafana/faro-core';

import { FetchTransport } from '../fetch';
import { isRetryableSendResult } from '../fetch/transport';
import type { FetchTransportOfflineStore } from '../fetch/types';

import { DefaultConnectivityService } from './ConnectivityService';
import { AsyncStorageOfflineCache } from './OfflineCache';
import type { CachedPayload, ConnectivityService, OfflineCache, OfflineTransportOptions } from './types';

/**
 * Default maximum cache duration: 3 days in milliseconds.
 */
const DEFAULT_MAX_CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Delays before retrying a replay that could not deliver everything. The last
 * value repeats. A pass that delivers something resets it.
 */
const REPLAY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** While Faro is paused, how often replay checks whether it was unpaused. */
const PAUSED_CHECK_MS = 5_000;

/** Replay saves its progress after this many changed entries, and at the end of a pass. */
const REPLAY_SAVE_EVERY = 50;

/** A replay pass skipped during a FetchTransport backoff runs again when it ends, but not sooner than this. */
const MIN_SKIPPED_RETRY_MS = 1_000;

/** At startup, how long replay waits for NetInfo's first answer. */
const STARTUP_CONNECTIVITY_WAIT_MS = 1_000;

/** Items larger than this (serialized) are not stored. */
const MAX_ITEM_LENGTH = 256 * 1024;

/** One cache write takes at most this much (serialized) or this many payloads; the rest goes in the next. */
const WRITE_BATCH_LENGTH = 128 * 1024;
const WRITE_BATCH_PAYLOADS = 100;

/**
 * A payload is dropped once replay counted this many retryable rejections
 * (5xx, 408) or exceptions thrown by a transport's `send()` for it, the first
 * at least `MIN_REJECTED_FOR_MS` ago: a payload that keeps failing, not a
 * collector outage. The live failure that stored it does not count.
 */
const MAX_REJECTIONS = 5;
const MIN_REJECTED_FOR_MS = 60 * 60 * 1000;

let warnedCheckIntervalDeprecated = false;

interface ReplayTarget {
  key: string;
  transport: Transport;
  /** False for transports that take one item per `send()` call. */
  batched: boolean;
}

interface QueuedPayload {
  payload: CachedPayload;
  /** Dedupe set the items were added to; they are removed again if the write fails. */
  stored: WeakSet<object>;
  /** Serialized length of the items. */
  length: number;
}

/** How a request, or the run of requests to one destination, ended. */
/**
 * `error`: the transport threw, which may be temporary; counted like a rejection.
 * `invalid`: no request can be built from the items, so they can never be sent.
 */
type DeliverOutcome = 'delivered' | 'failed' | 'rejected' | 'skipped' | 'stopped' | 'error' | 'invalid';

interface PassResult {
  /** Entries are left that a later pass should send. */
  pending: boolean;
  /** Some items were delivered. */
  progressed: boolean;
  /** Stopped because Faro was paused, the device went offline or the transport was disposed. */
  stopped: boolean;
  /** A request failed or was rejected with a retryable status: grows the retry delay. */
  failed: boolean;
  /** A FetchTransport skipped a request (backoff, paused, request buffer full). */
  skipped: boolean;
}

/**
 * OfflineTransport - Stores telemetry that could not be sent and sends it later.
 *
 * Each `FetchTransport` that replay sends through hands it the items its live
 * send did not deliver: the request failed or timed out, the collector
 * answered 408, 429 or 5xx, or the transport was in backoff or its request
 * buffer was full. While `@react-native-community/netinfo` (optional) reports
 * the device offline, items are stored without a request. Stored items are
 * kept in AsyncStorage and sent in storage order through the `FetchTransport`
 * instances registered with the same Faro instance, or through the transports
 * set with `setOtherTransports()`. Replay calls those transports directly, so
 * `beforeSend` hooks, which already ran, do not run again.
 *
 * Replay runs at startup, after a retry delay (5 s up to 5 min), after a live
 * request is accepted, when the app comes to the foreground, and when NetInfo
 * reports the device online. It waits while Faro is paused or NetInfo reports
 * the device offline. When NetInfo reports the device online again, the
 * failure backoff of the `FetchTransport` instances ends, so delivery resumes
 * at once; a rate-limit backoff (429) is kept.
 *
 * A payload leaves the cache once every destination accepted it, rejected it
 * with a non-retryable status (4xx other than 408 and 429), replay got a 5xx
 * or 408 for it five times, it expired, or the cache limits evicted it.
 * Delivery is at least once: a request that timed out after the collector
 * accepted it is sent again. Storage order is the order in which live sends
 * failed, so items from overlapping requests can be stored, and sent, in a
 * different order than they were captured.
 *
 * @example
 * ```typescript
 * import { initializeFaro, OfflineTransport } from '@grafana/faro-react-native';
 *
 * // The SDK adds a FetchTransport for `url`; replay sends through it.
 * initializeFaro({
 *   url: 'https://collector.example.com',
 *   app: { name: 'my-app' },
 *   transports: [new OfflineTransport({ maxCacheDurationMs: 24 * 60 * 60 * 1000 })],
 * });
 * ```
 */
export class OfflineTransport extends BaseTransport {
  readonly name = '@grafana/faro-react-native:transport-offline';
  readonly version = VERSION;

  private readonly cache: OfflineCache;
  private readonly connectivityService: ConnectivityService;
  private readonly maxCacheDurationMs: number;
  private explicitTargets: Transport[] | null = null;
  private registeredTransports: Transports | null = null;
  private bound = false;
  /** The transports this package's `initializeFaro` builds, known before Faro registers them. */
  private connectedTransports: Transport[] | null = null;
  private unsubscribeConnectivity: (() => void) | null = null;
  private appStateSubscription: NativeEventSubscription | null = null;
  /** FetchTransports that hand undelivered live items to this transport. */
  private readonly attached = new Map<FetchTransport, FetchTransportOfflineStore>();
  private replayPromise: Promise<void> | null = null;
  private replayRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the retry timer fires, as `Date.now()` time. */
  private retryDueAt = 0;
  private retryAttempt = 0;
  /** Payloads to store, not yet written to the cache. */
  private writeQueue: QueuedPayload[] = [];
  /** Writes the queue until it is empty, one storage write at a time; null when idle. Never rejects. */
  private drainPromise: Promise<void> | null = null;
  /** Items already stored, by destination keys, so each is stored once per destination. */
  private readonly storedItems = new Map<string, WeakSet<object>>();
  /** False after a replay pass emptied the cache and nothing was stored since. */
  private mayHaveEntries = true;
  private disposed = false;
  /** Last connectivity state reported by the connectivity service was offline. */
  private reportedOffline = false;
  /** Pending until the first connectivity state is known, or the startup wait ends; then null. */
  private startupWait: Promise<void> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OfflineTransportOptions = {}) {
    super();

    this.maxCacheDurationMs = options.maxCacheDurationMs ?? DEFAULT_MAX_CACHE_DURATION_MS;

    this.cache = new AsyncStorageOfflineCache({
      storageKeyPrefix: options.storageKeyPrefix,
      maxCacheSize: options.maxCacheSize,
      maxCacheBytes: options.maxCacheBytes,
      maxCacheDurationMs: this.maxCacheDurationMs,
      warn: (message) => this.logWarn(message),
    });

    if (options.connectivityCheckIntervalMs !== undefined && !warnedCheckIntervalDeprecated) {
      warnedCheckIntervalDeprecated = true;
      defaultUnpatchedConsole.warn(
        'Faro: the OfflineTransport option connectivityCheckIntervalMs is deprecated and has no effect; telemetry is stored when sending it fails'
      );
    }

    this.connectivityService = new DefaultConnectivityService();
    // An offline cold start should not spend a request that fails.
    const known = this.connectivityService.whenKnown();
    this.startupWait = new Promise<void>((resolve) => {
      this.startupTimer = setTimeout(resolve, STARTUP_CONNECTIVITY_WAIT_MS);
      known.then(resolve, resolve);
    }).then(() => {
      this.clearStartupTimer();
      this.startupWait = null;
    });
    this.unsubscribeConnectivity = this.connectivityService.subscribe((isOnline) => {
      const wasOffline = this.reportedOffline;
      this.reportedOffline = !isOnline;
      if (isOnline) {
        if (wasOffline) {
          this.onReconnect();
        } else {
          this.requestReplay();
        }
      }
    });

    try {
      this.appStateSubscription =
        AppState.addEventListener?.('change', (state: AppStateStatus) => this.onAppStateChange(state)) ?? null;
    } catch {
      // No AppState: replay still runs on the other triggers.
    }
  }

  /**
   * While the device is known to be offline (NetInfo), stores the items for
   * the destinations that no `FetchTransport` registered with Faro stores
   * itself: transports set with `setOtherTransports()` that are not
   * registered, or every destination while they are not known yet. Otherwise
   * does nothing; the registered `FetchTransport` instances hand over what
   * they cannot deliver.
   */
  async send(items: TransportItem | TransportItem[]): Promise<void> {
    const itemsArray = Array.isArray(items) ? items : [items];

    if (itemsArray.length === 0 || this.disposed || this.connectivityService.isOnline) {
      return;
    }

    const targets = this.getReplayTargets();
    if (targets === null) {
      this.store(itemsArray, null);
      return;
    }
    // With faro-core's initializeFaro, registered transports are known only once Faro added them.
    this.attachToTargets();
    const live = this.getLiveTransports() ?? [];
    // Destinations a registered FetchTransport sends to live: it stores what it does not deliver.
    const storedLive = new Set(
      Array.from(this.attached.keys())
        .filter((transport) => live.includes(transport))
        .map((transport) => transport.getDestinationKey())
    );
    const keys = targets.filter(({ key }) => !storedLive.has(key)).map(({ key }) => key);
    if (keys.length > 0) {
      this.store(itemsArray, keys);
    }
  }

  /**
   * Returns the ignore URLs of transports set with `setOtherTransports()`, so
   * HTTP and tracing instrumentation skip replay requests even when those
   * transports are not registered with Faro.
   */
  override getIgnoreUrls(): Patterns {
    return (this.explicitTargets ?? []).flatMap((transport) => {
      try {
        return transport.getIgnoreUrls();
      } catch {
        return [];
      }
    });
  }

  override isBatched(): boolean {
    return true;
  }

  /**
   * Sets the transports that replay sends cached payloads to, replacing the
   * default: the `FetchTransport` instances registered with the same Faro
   * instance. Call it before `initializeFaro`.
   *
   * - A `FetchTransport` in this list that is also registered with Faro hands
   *   its undelivered live items to this transport. Items are stored for the
   *   other transports in this list only while NetInfo reports the device
   *   offline.
   * - Offline transports are ignored.
   * - Transports registered with the same Faro instance that are not a
   *   `FetchTransport` are skipped: they already received the items live.
   * - Transports whose `isBatched()` returns false get one item per `send()`.
   * - For a `FetchTransport`, the collector response decides. For other
   *   transports, a `send()` that resolves counts as delivered and one that
   *   throws or rejects is retried.
   * - Replay tracks delivery per destination: the collector URL for a
   *   `FetchTransport`, otherwise the transport's name and position in this
   *   list. Keep the list order stable across app launches.
   */
  setOtherTransports(transports: Transport[]): void {
    this.explicitTargets = transports;
    this.attachToTargets();
  }

  /**
   * Makes the `FetchTransport` instances in `transports`, which Faro is about
   * to register, hand undelivered items to this transport from the first
   * item sent while Faro initializes. Replay waits for `bindTransports()`.
   * `initializeFaro` from this package calls it before core initialization.
   *
   * @internal
   */
  connectTransportList(transports: Transport[]): void {
    if (this.disposed || this.registeredTransports) {
      return;
    }
    this.connectedTransports = transports;
    this.attachToTargets();
  }

  /**
   * Connects this transport to the Faro instance it is registered with, so
   * replay can find its `FetchTransport` instances and they hand undelivered
   * items to it, and replays the cache. `initializeFaro` from this package
   * calls it.
   *
   * @internal
   */
  bindTransports(transports: Transports): void {
    this.bound = true;
    this.registeredTransports = transports;
    this.attachToTargets();
    this.requestReplay();
  }

  /**
   * True once bound to a Faro instance with `bindTransports()`, until disposed.
   *
   * @internal
   */
  isBound(): boolean {
    return this.bound && !this.disposed;
  }

  /**
   * Get the current number of cached payloads, after writing items waiting to
   * be stored.
   */
  async getCachedCount(): Promise<number> {
    await this.waitForWrites();
    return this.cache.getCount();
  }

  /**
   * Replay cached payloads now, unless Faro is paused. If a replay is already
   * running, waits for it and the extra pass this call requests.
   */
  async forceReplay(): Promise<void> {
    await this.replayCachedPayloads();
  }

  /**
   * Clear all cached payloads, including items waiting to be stored.
   */
  async clearCache(): Promise<void> {
    this.writeQueue = [];
    await this.waitForWrites();
    await this.cache.clear();
  }

  /**
   * Clean up resources. After this, the transport no longer caches or replays.
   * Items already handed over are still written to the cache.
   */
  dispose(): void {
    this.attached.forEach((store, transport) => detach(transport, store));
    this.attached.clear();
    this.disposed = true;
    this.clearRetryTimer();
    this.clearStartupTimer();
    if (this.unsubscribeConnectivity) {
      this.unsubscribeConnectivity();
      this.unsubscribeConnectivity = null;
    }
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.connectivityService.dispose();
  }

  /**
   * Makes each `FetchTransport` replay target hand its undelivered live items
   * to this transport, and detaches the ones that are no longer targets.
   */
  private attachToTargets(): void {
    if (this.disposed) {
      return;
    }
    const keys = new Set(
      (this.getReplayTargets() ?? [])
        .filter(({ transport }) => transport instanceof FetchTransport)
        .map(({ key }) => key)
    );
    // Also the registered ones that share a collector URL with a target: they send the same items live.
    const candidates: FetchTransport[] = [...(this.explicitTargets ?? []), ...(this.getLiveTransports() ?? [])].filter(
      (transport): transport is FetchTransport => transport instanceof FetchTransport
    );
    const targets = Array.from(new Set(candidates), (transport) => ({
      transport,
      key: transport.getDestinationKey(),
    })).filter(({ key }) => keys.has(key));
    const wanted = new Set<FetchTransport>(targets.map(({ transport }) => transport));
    Array.from(this.attached.entries()).forEach(([transport, store]) => {
      if (!wanted.has(transport)) {
        detach(transport, store);
        this.attached.delete(transport);
      }
    });
    for (const { transport, key } of targets) {
      if (this.attached.has(transport)) {
        continue;
      }
      // Owned by an offline transport of an active Faro instance, for example when a second
      // initializeFaro that core rejects reuses this FetchTransport: that one keeps storing.
      const current = transport.getOfflineStore();
      if (current?.isBound()) {
        continue;
      }
      const store: FetchTransportOfflineStore = {
        isOffline: () => !this.disposed && !this.connectivityService.isOnline,
        store: (items) => this.store(items, [key]),
        delivered: () => this.onLiveDelivered(),
        isBound: () => this.isBound(),
      };
      transport.setOfflineStore(store);
      this.attached.set(transport, store);
    }
  }

  /**
   * Stores items as one cache entry for the destinations in `keys`, or for
   * every destination when `keys` is null. The entry is written right away,
   * or with the others stored meanwhile when a write is in flight.
   */
  private store(items: TransportItem[], keys: string[] | null): void {
    if (this.disposed || items.length === 0) {
      return;
    }
    const id = keys ? JSON.stringify(keys) : '*';
    // Several FetchTransports for one collector URL hand over the same items.
    let stored = this.storedItems.get(id);
    if (!stored) {
      stored = new WeakSet();
      this.storedItems.set(id, stored);
    }
    let length = 0;
    let tooLarge = 0;
    const newItems = items.filter((item) => {
      if (stored.has(item)) {
        return false;
      }
      const itemLength = serializedLength(item);
      if (itemLength > MAX_ITEM_LENGTH) {
        tooLarge++;
        return false;
      }
      length += itemLength;
      return true;
    });
    if (tooLarge > 0) {
      this.logWarn(`Not storing ${tooLarge} items larger than ${MAX_ITEM_LENGTH} characters`);
    }
    if (newItems.length === 0) {
      return;
    }
    newItems.forEach((item) => stored.add(item));

    // Destinations the items are not for count as done.
    const done = keys ? (this.getReplayTargets() ?? []).map(({ key }) => key).filter((key) => !keys.includes(key)) : [];
    const payload: CachedPayload = {
      timestamp: Date.now(),
      items: newItems,
      ...(done.length > 0 && { progress: Object.fromEntries(done.map((key) => [key, newItems.length])) }),
    };
    this.writeQueue.push({ payload, stored, length });
    this.mayHaveEntries = true;
    this.logDebug(`Storing ${newItems.length} items for a later retry`);
    this.drainWriteQueue();

    // A running replay schedules the retry when it ends. While offline, reconnecting replays.
    if (!this.replayPromise && !this.isOffline()) {
      if (this.isPaused()) {
        // Replaces a longer retry delay, so the items go out soon after unpause. FetchTransport
        // still waits for Retry-After and its backoff, and the retry attempt count is kept.
        if (!this.retryTimer || this.retryDueAt > Date.now() + PAUSED_CHECK_MS) {
          this.schedulePausedCheck();
        }
      } else if (!this.retryTimer) {
        this.startRetryTimer(this.retryDelay());
      }
    }
  }

  private drainWriteQueue(): void {
    if (this.drainPromise || this.writeQueue.length === 0) {
      return;
    }
    this.drainPromise = (async () => {
      // The first write awaits before this loop ends, so drainPromise is set by then.
      while (this.writeQueue.length > 0) {
        let count = 0;
        let length = 0;
        for (const queued of this.writeQueue) {
          if (count >= WRITE_BATCH_PAYLOADS || (count > 0 && length + queued.length > WRITE_BATCH_LENGTH)) {
            break;
          }
          count++;
          length += queued.length;
        }
        const batch = this.writeQueue.splice(0, count);
        try {
          await this.cache.writeMany(batch.map(({ payload }) => payload));
          this.logDebug(`Cached ${batch.length} payloads for replay`);
        } catch (error) {
          // Not stored, so a later hand-over of the same items can store them.
          batch.forEach(({ payload, stored }) => payload.items.forEach((item) => stored.delete(item)));
          this.logError('Failed to cache offline payload', error);
        }
      }
      this.drainPromise = null;
    })();
  }

  /** Resolves when every payload stored so far, and those stored meanwhile, is written. Never rejects. */
  private waitForWrites(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  /** A live request was accepted, so the collector is reachable: replay what is stored. */
  private onLiveDelivered(): void {
    if (this.mayHaveEntries && !this.replayPromise) {
      this.requestReplay();
    }
  }

  /**
   * NetInfo reported the device online after reporting it offline: requests
   * that failed before are no reason to wait, so end the failure backoff and
   * the retry delay and replay now.
   */
  private onReconnect(): void {
    if (this.disposed) {
      return;
    }
    this.attached.forEach((_store, transport) => transport.resetFailureBackoff());
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.requestReplay();
  }

  private onAppStateChange(state: AppStateStatus): void {
    if (state === 'active') {
      this.requestReplay();
    }
  }

  /**
   * The transports registered with the Faro instance: bound by this package's
   * `initializeFaro`, or from the config faro-core gives each transport it
   * adds. Null before either.
   */
  private getLiveTransports(): Transport[] | null {
    if (this.registeredTransports) {
      return this.registeredTransports.transports;
    }
    if (this.connectedTransports) {
      return this.connectedTransports;
    }
    const configured: unknown = this.config?.transports;
    return Array.isArray(configured) ? (configured as Transport[]) : null;
  }

  private isPaused(): boolean {
    return this.config?.paused === true || this.registeredTransports?.isPaused() === true;
  }

  /** NetInfo reports the device offline. */
  private isOffline(): boolean {
    return !this.connectivityService.isOnline;
  }

  /** Replay must not send now. */
  private shouldStop(): boolean {
    return this.disposed || this.isPaused() || this.isOffline();
  }

  private requestReplay(): void {
    if (!this.disposed) {
      void this.replayCachedPayloads();
    }
  }

  /**
   * Runs one replay at a time. A request during a replay waits for it and
   * makes it run one more pass, which picks up entries cached meanwhile. Does
   * nothing without targets, so a request before `bindTransports()` does not
   * hold up the one it makes.
   */
  private replayCachedPayloads(): Promise<void> {
    if (this.replayPromise) {
      this.replayRequested = true;
      return this.replayPromise;
    }
    // With this package's initializeFaro, replay waits for bindTransports(), which follows core init.
    const waitingForBind = this.connectedTransports !== null && this.registeredTransports === null;
    if (this.disposed || waitingForBind || !this.getReplayTargets()?.length) {
      return Promise.resolve();
    }
    if (this.startupWait) {
      return this.startupWait.then(() => this.replayCachedPayloads());
    }
    if (this.isPaused()) {
      // Faro does not report unpausing; check again later.
      this.schedulePausedCheck();
      return Promise.resolve();
    }
    if (this.isOffline()) {
      // Reconnecting replays; no timer needed.
      return Promise.resolve();
    }
    this.clearRetryTimer();
    this.replayPromise = (async () => {
      let result: PassResult;
      do {
        this.replayRequested = false;
        result = await this.runReplayPass().catch((error: unknown): PassResult => {
          // Usually a storage error; try again later like a failed delivery.
          this.logError('Failed to replay cached payloads', error);
          return { pending: true, progressed: false, stopped: false, failed: true, skipped: false };
        });
        if (result.pending) {
          this.mayHaveEntries = true;
        }
        // A pending result schedules a retry anyway; a stopped pass runs again if asked to meanwhile.
      } while (this.replayRequested && (!result.pending || result.stopped));
      this.scheduleRetry(result);
      if (
        !result.pending &&
        this.mayHaveEntries &&
        !this.retryTimer &&
        !this.disposed &&
        !this.isPaused() &&
        !this.isOffline()
      ) {
        // Items stored during the pass failed just now: retry them after a delay.
        this.startRetryTimer(this.retryDelay());
      }
    })().finally(() => {
      this.replayPromise = null;
    });
    return this.replayPromise;
  }

  private async runReplayPass(): Promise<PassResult> {
    const result: PassResult = { pending: false, progressed: false, stopped: false, failed: false, skipped: false };
    const targets = this.getReplayTargets();
    if (!targets?.length) {
      return result;
    }
    if (this.shouldStop()) {
      return { ...result, pending: true, stopped: true };
    }

    // Anything stored from here on sets it again.
    this.mayHaveEntries = false;
    // Items still being stored belong at the end of the cache.
    await this.waitForWrites();

    const now = Date.now();
    // Destinations that could not take a payload in this pass. Later payloads
    // are not sent to them, which keeps the cache order per destination.
    const blocked = new Set<string>();
    let changes: Record<string, CachedPayload | null> = {};
    let changeCount = 0;
    let replaying = false;

    try {
      for await (const payload of this.cache.read()) {
        if (this.shouldStop()) {
          result.pending = true;
          result.stopped = true;
          break;
        }
        if (blocked.size === targets.length) {
          result.pending = true;
          break;
        }
        const { id, items } = payload;
        if (!id) {
          continue;
        }
        if (!replaying) {
          replaying = true;
          this.logDebug('Replaying cached payloads');
        }

        const progress = { ...payload.progress };
        let rejections = payload.rejections ?? 0;
        let firstRejectedAt = payload.firstRejectedAt;
        let invalid = false;
        let changed = false;
        if (now - payload.timestamp > this.maxCacheDurationMs) {
          this.logDebug(`Dropping expired payload from ${new Date(payload.timestamp).toISOString()}`);
          changes[id] = null;
        } else {
          for (const target of targets) {
            if (invalid) {
              break;
            }
            const start = progress[target.key] ?? 0;
            let sent = start;
            if (!blocked.has(target.key)) {
              const delivery = await this.deliverFrom(target, items, start);
              sent = delivery.sent;
              this.recordOutcome(result, delivery.outcome);
              // 429 is a rate limit, not a problem with the payload.
              if ((delivery.outcome === 'rejected' && delivery.status !== 429) || delivery.outcome === 'error') {
                rejections++;
                firstRejectedAt ??= now;
                changed = true;
              }
              invalid ||= delivery.outcome === 'invalid';
            }
            if (sent < items.length && !invalid) {
              blocked.add(target.key);
            }
            if (sent !== start) {
              progress[target.key] = sent;
              changed = true;
              result.progressed = true;
            }
          }
          if (targets.every((target) => (progress[target.key] ?? 0) >= items.length)) {
            changes[id] = null;
          } else if (invalid) {
            this.logWarn('Dropping cached payload that cannot be sent');
            changes[id] = null;
          } else if (
            rejections >= MAX_REJECTIONS &&
            firstRejectedAt !== undefined &&
            now - firstRejectedAt >= MIN_REJECTED_FOR_MS
          ) {
            this.logWarn(`Dropping cached payload after ${rejections} retryable rejections in over an hour`);
            changes[id] = null;
          } else if (changed) {
            changes[id] = {
              ...payload,
              progress,
              ...(rejections > 0 && { rejections }),
              ...(firstRejectedAt !== undefined && { firstRejectedAt }),
            };
            result.pending = true;
          } else {
            result.pending = true;
            continue;
          }
        }
        if (++changeCount % REPLAY_SAVE_EVERY === 0) {
          await this.cache.update(changes);
          changes = {};
        }
      }
    } finally {
      // Saves progress also when the pass stops early. Delivery is at least
      // once: entries sent since the last save are sent again after a crash.
      if (Object.keys(changes).length > 0) {
        await this.cache.update(changes);
      }
    }

    return result;
  }

  private recordOutcome(result: PassResult, outcome: DeliverOutcome): void {
    if (outcome === 'failed' || outcome === 'rejected' || outcome === 'error') {
      result.failed = true;
    } else if (outcome === 'skipped') {
      result.skipped = true;
    } else if (outcome === 'stopped') {
      result.stopped = true;
    }
  }

  /**
   * Sends `items` from `start` on to one destination, one run of items with
   * the same meta per request (one item for non-batched transports), until
   * one is not delivered. Returns how many items the destination has now, and
   * why it stopped before the end.
   */
  private async deliverFrom(
    target: ReplayTarget,
    items: TransportItem[],
    start: number
  ): Promise<{ sent: number; outcome: DeliverOutcome; status?: number }> {
    let cursor = start;
    while (cursor < items.length) {
      // Checked before every request: Faro can be paused, or the device go offline, while a pass runs.
      if (this.shouldStop()) {
        return { sent: cursor, outcome: 'stopped' };
      }
      let end = cursor + 1;
      if (target.batched) {
        const meta = JSON.stringify(items[cursor]?.meta);
        while (end < items.length && JSON.stringify(items[end]?.meta) === meta) {
          end++;
        }
      }
      const delivery = await this.deliver(target.transport, items.slice(cursor, end), target.batched);
      if (delivery.outcome !== 'delivered') {
        return { sent: cursor, ...delivery };
      }
      cursor = end;
    }
    return { sent: cursor, outcome: 'delivered' };
  }

  /** 'delivered' also when the items were rejected as non-retryable: they are not sent again. */
  private async deliver(
    transport: Transport,
    items: TransportItem[],
    batched: boolean
  ): Promise<{ outcome: DeliverOutcome; status?: number }> {
    try {
      if (!(transport instanceof FetchTransport)) {
        await transport.send(batched ? items : (items[0] as TransportItem));
        return { outcome: 'delivered' };
      }

      if (!canBuildRequest(items)) {
        return { outcome: 'invalid' };
      }
      const result = await transport.sendWithResult(items);
      if (result.outcome !== 'accepted' && isRetryableSendResult(result)) {
        return { outcome: result.outcome, status: result.status };
      }
      if (result.outcome === 'rejected') {
        this.logWarn(`Dropping cached payload rejected with status ${result.status}`);
      }
      return { outcome: 'delivered' };
    } catch (error) {
      this.logDebug(`Replay through ${transport.name} failed: ${String(error)}`);
      return { outcome: 'error' };
    }
  }

  /**
   * Returns the destinations replay sends to, or null when they are not known
   * yet: no explicit targets and not bound to a Faro instance.
   */
  private getReplayTargets(): ReplayTarget[] | null {
    const registered = this.registeredTransports?.transports ?? this.connectedTransports;
    let candidates: Array<{ transport: Transport; key: string }>;

    if (this.explicitTargets) {
      candidates = this.explicitTargets
        .map((transport, index) => ({
          transport,
          key: transport instanceof FetchTransport ? transport.getDestinationKey() : `${transport.name}#${index}`,
        }))
        .filter(
          ({ transport }) =>
            !isOfflineTransport(transport) &&
            // Registered non-Fetch transports received every item live; replay would send them twice.
            (transport instanceof FetchTransport || !this.getLiveTransports()?.includes(transport))
        );
    } else if (registered) {
      // Only FetchTransport hands over what it did not deliver live, so only it can replay without duplicates.
      candidates = registered
        .filter((transport): transport is FetchTransport => transport instanceof FetchTransport)
        .map((transport) => ({ transport, key: transport.getDestinationKey() }));
    } else {
      return null;
    }

    // Transports with the same key are one destination.
    const targets = new Map<string, ReplayTarget>();
    for (const { transport, key } of candidates) {
      if (!targets.has(key)) {
        targets.set(key, { key, transport, batched: isBatchedSafe(transport) });
      }
    }
    return Array.from(targets.values());
  }

  private scheduleRetry(result: PassResult): void {
    if (!result.pending || result.progressed) {
      this.retryAttempt = 0;
    }
    if (!result.pending || this.disposed) {
      return;
    }
    if (this.isPaused()) {
      this.schedulePausedCheck();
      return;
    }
    if (this.isOffline()) {
      // Reconnecting replays.
      return;
    }
    if (result.stopped && !result.failed && !result.skipped) {
      // Stopped by a pause or going offline that has ended meanwhile.
      this.startRetryTimer(MIN_SKIPPED_RETRY_MS);
      return;
    }
    let delay = 0;
    // Only failed or rejected requests grow the delay; a skipped pass runs again when the backoff ends.
    if (result.failed || !result.skipped) {
      delay = this.retryDelay();
      this.retryAttempt++;
    }
    if (result.skipped || result.failed) {
      delay = Math.max(delay, this.backoffEnd() - Date.now(), MIN_SKIPPED_RETRY_MS);
    }
    this.logDebug(`Retrying offline replay in ${delay}ms`);
    this.startRetryTimer(delay);
  }

  /** When the backoff of the FetchTransport replay targets ends, as `Date.now()` time. */
  private backoffEnd(): number {
    return Math.max(
      0,
      ...(this.getReplayTargets() ?? []).map(({ transport }) =>
        transport instanceof FetchTransport ? transport.getBackoffUntil() : 0
      )
    );
  }

  private retryDelay(): number {
    return REPLAY_RETRY_DELAYS_MS[Math.min(this.retryAttempt, REPLAY_RETRY_DELAYS_MS.length - 1)] ?? 0;
  }

  private schedulePausedCheck(): void {
    this.startRetryTimer(PAUSED_CHECK_MS);
  }

  private startRetryTimer(delay: number): void {
    this.clearRetryTimer();
    this.retryDueAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestReplay();
    }, delay);
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

function detach(transport: FetchTransport, store: FetchTransportOfflineStore): void {
  if (transport.getOfflineStore() === store) {
    transport.setOfflineStore(null);
  }
}

/** FetchTransport builds its request body like this; it throws for some malformed items. */
function canBuildRequest(items: TransportItem[]): boolean {
  try {
    JSON.stringify(getTransportBody(items));
    return true;
  } catch {
    return false;
  }
}

function serializedLength(item: TransportItem): number {
  try {
    return JSON.stringify(item).length;
  } catch {
    // Not serializable, so it cannot be stored either.
    return Infinity;
  }
}

function isOfflineTransport(transport: Transport): boolean {
  return transport instanceof OfflineTransport || transport.name === '@grafana/faro-react-native:transport-offline';
}

function isBatchedSafe(transport: Transport): boolean {
  try {
    return transport.isBatched();
  } catch {
    return true;
  }
}
