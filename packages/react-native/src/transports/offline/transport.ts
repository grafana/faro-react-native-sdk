import { BaseTransport, VERSION } from '@grafana/faro-core';
import type { Patterns, Transport, TransportItem, Transports } from '@grafana/faro-core';

import { claimForOfflineReplay } from '../claims';
import { FetchTransport } from '../fetch';

import { DefaultConnectivityService } from './ConnectivityService';
import { AsyncStorageOfflineCache } from './OfflineCache';
import type { CachedPayload, ConnectivityService, OfflineCache, OfflineTransportOptions } from './types';

/**
 * Default maximum cache duration: 3 days in milliseconds.
 */
const DEFAULT_MAX_CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Delays before retrying a replay that could not deliver everything while
 * online. The last value repeats. A pass that delivers something resets it.
 */
const REPLAY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** Replay saves its progress after this many changed entries, and at the end of a pass. */
const REPLAY_SAVE_EVERY = 50;

interface ReplayTarget {
  key: string;
  transport: Transport;
  /** False for transports that take one item per `send()` call. */
  batched: boolean;
}

/**
 * OfflineTransport - Caches telemetry when offline and replays it when online.
 *
 * While the device is offline, items are written to AsyncStorage instead of
 * being sent live: `FetchTransport` skips them. When connectivity returns, the
 * cache is replayed oldest first through the `FetchTransport` instances
 * registered with the same Faro instance, or through the transports set with
 * `setOtherTransports()`. Replay calls those transports directly, so
 * `beforeSend` hooks, which already ran before the items were cached, do not
 * run again. Without any transport to replay through, nothing is cached.
 *
 * A payload leaves the cache once every destination accepted it, rejected it
 * with a non-retryable status (4xx other than 408 and 429), or it expired.
 * Otherwise it stays and replay is retried with a growing delay
 * (5 s up to 5 min), and on the next connectivity change.
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
  private unsubscribeConnectivity: (() => void) | null = null;
  private replayPromise: Promise<void> | null = null;
  private replayRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** Cache writes run one `send()` at a time, so cache order is capture order. Never rejects. */
  private pendingWrites: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: OfflineTransportOptions = {}) {
    super();

    this.maxCacheDurationMs = options.maxCacheDurationMs ?? DEFAULT_MAX_CACHE_DURATION_MS;

    this.cache = new AsyncStorageOfflineCache({
      storageKeyPrefix: options.storageKeyPrefix,
      maxCacheSize: options.maxCacheSize,
    });

    this.connectivityService = new DefaultConnectivityService(options.connectivityCheckIntervalMs);

    // Subscribe to connectivity changes
    this.unsubscribeConnectivity = this.connectivityService.subscribe((isOnline) => {
      if (isOnline) {
        this.requestReplay();
      }
    });
  }

  /**
   * Send telemetry items.
   *
   * When offline, items are cached for later replay and claimed so
   * `FetchTransport` does not also send them live. When online, or when there
   * is no transport to replay through, this transport does nothing; the other
   * transports send the items.
   */
  async send(items: TransportItem | TransportItem[]): Promise<void> {
    const itemsArray = Array.isArray(items) ? items : [items];

    if (itemsArray.length === 0 || this.disposed || this.connectivityService.isOnline) {
      return;
    }

    const targets = this.getReplayTargets();
    if (targets?.length === 0) {
      return;
    }
    // Targets are unknown until this transport is bound to Faro or given explicit
    // ones; cache then, but don't claim, so FetchTransport still tries live.
    if (targets) {
      // Must run synchronously, before network transports in the same dispatch look at the items.
      claimForOfflineReplay(itemsArray);
    }

    const payload: CachedPayload = { timestamp: Date.now(), items: itemsArray };
    const write = this.pendingWrites.then(() => this.cache.write(payload));
    this.pendingWrites = write.catch(() => undefined);

    try {
      await write;
      this.logDebug(`Cached ${itemsArray.length} items for offline replay`);
    } catch (error) {
      this.logError('Failed to cache offline payload', error);
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
  }

  /**
   * Connects this transport to the Faro instance it is registered with, so
   * replay can find its `FetchTransport` instances, and replays the cache if
   * online. `initializeFaro` from this package calls it.
   *
   * @internal
   */
  bindTransports(transports: Transports): void {
    this.registeredTransports = transports;
    this.requestReplay();
  }

  /**
   * Get the current number of cached payloads.
   */
  async getCachedCount(): Promise<number> {
    return this.cache.getCount();
  }

  /**
   * Replay cached payloads now, if online. If a replay is already running,
   * waits for it and the extra pass this call requests.
   */
  async forceReplay(): Promise<void> {
    if (this.connectivityService.isOnline) {
      await this.replayCachedPayloads();
    }
  }

  /**
   * Clear all cached payloads.
   */
  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Clean up resources. After this, the transport no longer caches or replays.
   */
  dispose(): void {
    this.disposed = true;
    this.clearRetryTimer();
    if (this.unsubscribeConnectivity) {
      this.unsubscribeConnectivity();
      this.unsubscribeConnectivity = null;
    }
    this.connectivityService.dispose();
  }

  private requestReplay(): void {
    if (!this.disposed && this.connectivityService.isOnline) {
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
    if (!this.getReplayTargets()?.length) {
      return Promise.resolve();
    }
    this.clearRetryTimer();
    this.replayPromise = (async () => {
      let result: { pending: boolean; progressed: boolean };
      do {
        this.replayRequested = false;
        result = await this.runReplayPass().catch((error: unknown) => {
          // Usually a storage error; try again later like a failed delivery.
          this.logError('Failed to replay cached payloads', error);
          return { pending: true, progressed: false };
        });
        // A pending result schedules a retry anyway.
      } while (this.replayRequested && !result.pending);
      this.scheduleRetry(result);
    })().finally(() => {
      this.replayPromise = null;
    });
    return this.replayPromise;
  }

  private async runReplayPass(): Promise<{ pending: boolean; progressed: boolean }> {
    const targets = this.getReplayTargets();
    if (!targets?.length) {
      return { pending: false, progressed: false };
    }

    // Payloads still being written belong at the end of the cache.
    await this.pendingWrites;
    const payloads = await this.cache.readAll();
    if (payloads.length > 0) {
      this.logDebug(`Replaying ${payloads.length} cached payloads`);
    }

    const now = Date.now();
    // Destinations that could not take a payload in this pass. Later payloads
    // are not sent to them, which keeps the cache order per destination.
    const blocked = new Set<string>();
    let changes: Record<string, CachedPayload | null> = {};
    let changeCount = 0;
    let pending = false;
    let progressed = false;

    try {
      for (const payload of payloads) {
        if (this.disposed || !this.connectivityService.isOnline) {
          // The next connectivity change replays the rest.
          return { pending: false, progressed };
        }
        if (blocked.size === targets.length) {
          pending = true;
          break;
        }
        const { id, items } = payload;
        if (!id) {
          continue;
        }

        const progress = { ...payload.progress };
        let changed = false;
        if (now - payload.timestamp > this.maxCacheDurationMs) {
          this.logDebug(`Dropping expired payload from ${new Date(payload.timestamp).toISOString()}`);
          changes[id] = null;
        } else {
          for (const target of targets) {
            const start = progress[target.key] ?? 0;
            const sent = blocked.has(target.key) ? start : await this.deliverFrom(target, items, start);
            if (sent < items.length) {
              blocked.add(target.key);
            }
            if (sent !== start) {
              progress[target.key] = sent;
              changed = true;
            }
          }
          if (targets.every((target) => (progress[target.key] ?? 0) >= items.length)) {
            changes[id] = null;
          } else if (changed) {
            changes[id] = { ...payload, progress };
            pending = true;
          } else {
            pending = true;
            continue;
          }
        }
        progressed ||= changed;
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

    return { pending, progressed };
  }

  /**
   * Sends `items` from `start` on to one destination, one run of items with
   * the same meta per request (one item for non-batched transports), until
   * one is not delivered. Returns how many items the destination has now.
   */
  private async deliverFrom(target: ReplayTarget, items: TransportItem[], start: number): Promise<number> {
    let cursor = start;
    while (cursor < items.length) {
      let end = cursor + 1;
      if (target.batched) {
        const meta = JSON.stringify(items[cursor]?.meta);
        while (end < items.length && JSON.stringify(items[end]?.meta) === meta) {
          end++;
        }
      }
      if (!(await this.deliver(target.transport, items.slice(cursor, end), target.batched))) {
        break;
      }
      cursor = end;
    }
    return cursor;
  }

  /** True when the items were delivered or rejected as non-retryable; false to retry later. */
  private async deliver(transport: Transport, items: TransportItem[], batched: boolean): Promise<boolean> {
    try {
      if (!(transport instanceof FetchTransport)) {
        await transport.send(batched ? items : (items[0] as TransportItem));
        return true;
      }

      const result = await transport.sendWithResult(items);
      if (result.outcome === 'accepted') {
        return true;
      }
      if (result.outcome === 'rejected' && isNonRetryableStatus(result.status)) {
        this.logWarn(`Dropping cached payload rejected with status ${result.status}`);
        return true;
      }
      return false;
    } catch (error) {
      this.logDebug(`Replay through ${transport.name} failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * Returns the destinations replay sends to, or null when they are not known
   * yet: no explicit targets and not bound to a Faro instance.
   */
  private getReplayTargets(): ReplayTarget[] | null {
    const registered = this.registeredTransports?.transports;
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
            (transport instanceof FetchTransport || !registered?.includes(transport))
        );
    } else if (registered) {
      // Only FetchTransport skips claimed items live, so only it can replay without duplicates.
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

  private scheduleRetry({ pending, progressed }: { pending: boolean; progressed: boolean }): void {
    if (!pending || progressed) {
      this.retryAttempt = 0;
    }
    if (!pending || this.disposed || !this.connectivityService.isOnline) {
      return;
    }
    const delay = REPLAY_RETRY_DELAYS_MS[Math.min(this.retryAttempt, REPLAY_RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt++;
    this.logDebug(`Retrying offline replay in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestReplay();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
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

/**
 * Client errors other than timeout (408) and rate limit (429) mean the
 * collector will not accept the payload on retry either.
 */
function isNonRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
