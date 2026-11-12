import { BaseTransport, VERSION } from '@grafana/faro-core';
import type { Patterns, Transport, TransportItem, Transports } from '@grafana/faro-core';

import { claimForOfflineReplay } from '../claims';
import { FetchTransport } from '../fetch';
import { groupContiguousItemsByMeta } from '../groupItemsByMeta';

import { DefaultConnectivityService } from './ConnectivityService';
import { AsyncStorageOfflineCache } from './OfflineCache';
import type {
  CachedPayload,
  ConnectivityService,
  DeliveryReportingTransport,
  OfflineCache,
  OfflineTransportOptions,
} from './types';

/**
 * Default maximum cache duration: 3 days in milliseconds.
 */
const DEFAULT_MAX_CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Delays before retrying a replay that could not deliver everything while
 * online. The last value repeats. Progress resets the sequence.
 */
const REPLAY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;

type DeliveryStatus = 'delivered' | 'dropped' | 'retry';

interface ReplayTarget {
  key: string;
  transport: Transport;
  /** False for transports that take one item per `send()` call. */
  batched: boolean;
}

interface ExplicitTarget {
  transport: Transport;
  /** Position in the list passed to `setOtherTransports()`, used for the fallback destination key. */
  index: number;
}

type ReplayPassResult = { state: 'done' | 'pending' | 'idle'; progressed: boolean };

/**
 * OfflineTransport - Caches telemetry when offline and replays it when online.
 *
 * While the device is offline, items are written to AsyncStorage instead of
 * being sent live: `FetchTransport` skips them. When connectivity returns, the
 * cache is replayed oldest first through the `FetchTransport` instances
 * registered with the same Faro instance, or through the transports set with
 * `setOtherTransports()`. Replay calls those transports directly, so
 * `beforeSend` hooks, which already ran before the items were cached, do not
 * run again.
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
  private explicitTargets: ExplicitTarget[] | null = null;
  private registeredTransports: Transports | null = null;
  private unsubscribeConnectivity: (() => void) | null = null;
  private replayPromise: Promise<void> | null = null;
  private replayRequestedDuringReplay = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private startupReplayRequested = false;
  private warnedNoTargets = false;
  private readonly warnedSkippedTargets = new WeakSet<Transport>();
  private queuedWarnings: string[] = [];
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
   * `FetchTransport` does not also send them live. When online, this transport
   * does nothing; the other transports send the items.
   */
  async send(items: TransportItem | TransportItem[]): Promise<void> {
    const itemsArray = Array.isArray(items) ? items : [items];

    if (itemsArray.length === 0 || this.disposed) {
      return;
    }

    if (this.connectivityService.isOnline) {
      // The first item sent after Faro starts replays what an earlier run cached.
      if (!this.startupReplayRequested) {
        this.startupReplayRequested = true;
        this.requestReplay();
      }
      return;
    }

    // Must run synchronously, before network transports in the same dispatch look at the items.
    claimForOfflineReplay(itemsArray);

    // One payload per run of items with the same meta, so a payload is one
    // request per destination and replay keeps capture order.
    const timestamp = Date.now();
    const runs = groupContiguousItemsByMeta(itemsArray);
    const write = this.pendingWrites.then(async () => {
      for (const run of runs) {
        await this.cache.write({ timestamp, items: run });
      }
    });
    this.pendingWrites = write.catch(() => undefined);

    try {
      await write;
      this.logDebug(`Cached ${itemsArray.length} items for offline replay`);
    } catch (error) {
      // The items were claimed, so they are lost; later writes and replays are not affected.
      this.logError('Failed to cache offline payload', error);
    }
  }

  /**
   * Returns the ignore URLs of transports set with `setOtherTransports()`, so
   * HTTP and tracing instrumentation skip replay requests even when those
   * transports are not registered with Faro.
   */
  override getIgnoreUrls(): Patterns {
    return (this.explicitTargets ?? []).flatMap(({ transport }) => {
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
   * instance.
   *
   * - Offline transports are ignored.
   * - Transports registered with the same Faro instance that are not a
   *   `FetchTransport` are skipped with a warning: they already received the
   *   items live.
   * - Transports whose `isBatched()` returns false get one item per `send()`.
   * - A transport with `sendWithResult()` reports whether the collector
   *   accepted a payload. For other transports, a `send()` that resolves
   *   counts as delivered and one that throws or rejects is retried.
   * - Replay tracks delivery per destination: `getDestinationKey()` when the
   *   transport has it, otherwise its name and position in this list. Keep the
   *   list order stable across app launches.
   */
  setOtherTransports(transports: Transport[]): void {
    this.explicitTargets = transports
      .map((transport, index) => ({ transport, index }))
      .filter(({ transport }) => !isOfflineTransport(transport));
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
    const warnings = this.queuedWarnings;
    this.queuedWarnings = [];
    warnings.forEach((warning) => this.logWarn(warning));
    this.requestReplay();
  }

  /**
   * Logs a configuration warning once this transport has a logger, when it is
   * bound to its Faro instance. Used by the SDK config builder, which runs
   * before Faro exists.
   *
   * @internal
   */
  queueConfigWarning(message: string): void {
    this.queuedWarnings.push(message);
  }

  /**
   * Get the current number of cached payloads.
   */
  async getCachedCount(): Promise<number> {
    return this.cache.getCount();
  }

  /**
   * Replay cached payloads now, if online. If a replay is already running,
   * waits for it, including the extra pass this call requests after it.
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
    if (this.disposed || !this.connectivityService.isOnline) {
      return;
    }
    void this.replayCachedPayloads();
  }

  /**
   * Runs one replay at a time. A request during a replay runs another pass
   * after it, instead of a second concurrent replay of the same payloads.
   */
  private replayCachedPayloads(): Promise<void> {
    if (this.replayPromise) {
      this.replayRequestedDuringReplay = true;
      return this.replayPromise;
    }

    this.clearRetryTimer();

    this.replayPromise = (async () => {
      try {
        let result: ReplayPassResult;
        do {
          this.replayRequestedDuringReplay = false;
          try {
            result = await this.runReplayPass();
          } catch (error) {
            // Usually a storage error; try again later like a failed delivery.
            this.logError('Failed to replay cached payloads', error);
            result = { state: 'pending', progressed: false };
          }
        } while (this.replayRequestedDuringReplay && this.connectivityService.isOnline && !this.disposed);
        this.scheduleRetry(result);
      } finally {
        this.replayPromise = null;
      }
    })();

    return this.replayPromise;
  }

  private async runReplayPass(): Promise<ReplayPassResult> {
    const targets = this.getReplayTargets();
    if (targets === null) {
      // Not registered with Faro yet; registration or the first send triggers replay.
      return { state: 'idle', progressed: false };
    }

    // Payloads still being written belong at the end of the cache.
    await this.pendingWrites;
    const payloads = await this.splitMixedMetaPayloads(await this.cache.readAll());
    if (payloads.length === 0) {
      return { state: 'done', progressed: false };
    }

    if (targets.length === 0) {
      if (!this.warnedNoTargets) {
        this.warnedNoTargets = true;
        this.logWarn('No network transport to replay offline payloads through; they stay cached');
      }
      return { state: 'idle', progressed: false };
    }

    this.logDebug(`Replaying ${payloads.length} cached payloads`);

    const now = Date.now();
    // Destinations that could not take a payload in this pass. Later payloads
    // are not sent to them, which keeps the cache order per destination.
    const blocked = new Set<string>();
    let progressed = false;

    for (const payload of payloads) {
      if (this.disposed || !this.connectivityService.isOnline) {
        // Offline again or disposed; the next connectivity change replays.
        return { state: 'idle', progressed };
      }
      if (blocked.size === targets.length) {
        break;
      }
      const id = payload.id;
      if (!id) {
        continue;
      }

      if (now - payload.timestamp > this.maxCacheDurationMs || payload.items.length === 0) {
        this.logDebug(`Dropping expired payload from ${new Date(payload.timestamp).toISOString()}`);
        await this.cache.replace({ [id]: [] });
        continue;
      }

      const deliveredTo = new Set(payload.deliveredTo ?? []);
      const itemCursors: Record<string, number> = { ...payload.itemCursors };
      const current = (): CachedPayload => ({
        id,
        timestamp: payload.timestamp,
        items: payload.items,
        ...(deliveredTo.size > 0 && { deliveredTo: Array.from(deliveredTo) }),
        ...(Object.keys(itemCursors).length > 0 && { itemCursors: { ...itemCursors } }),
      });
      let changed = false;

      for (const target of targets) {
        if (deliveredTo.has(target.key) || blocked.has(target.key)) {
          continue;
        }

        let accepted: boolean;
        if (target.batched) {
          accepted = (await this.deliver(target.transport, payload.items, true)) !== 'retry';
        } else {
          // One item per send; save how far this destination got after each
          // item, so a retry resumes there instead of resending.
          let cursor = itemCursors[target.key] ?? 0;
          accepted = true;
          while (cursor < payload.items.length) {
            const item = payload.items[cursor];
            if (item === undefined || (await this.deliver(target.transport, [item], false)) === 'retry') {
              accepted = false;
              break;
            }
            cursor++;
            progressed = true;
            if (cursor < payload.items.length) {
              itemCursors[target.key] = cursor;
              await this.cache.replace({ [id]: [current()] });
            }
          }
        }

        if (accepted) {
          deliveredTo.add(target.key);
          delete itemCursors[target.key];
          changed = true;
          progressed = true;
        } else {
          blocked.add(target.key);
        }
      }

      // Saved after every payload, so a crash resends as little as possible.
      if (targets.every((target) => deliveredTo.has(target.key))) {
        await this.cache.replace({ [id]: [] });
      } else if (changed) {
        await this.cache.replace({ [id]: [current()] });
      }
    }

    return { state: blocked.size > 0 ? 'pending' : 'done', progressed };
  }

  /**
   * Entries from older SDK versions can mix metas in one payload. Splits them
   * into runs of the same meta, in order, so a payload is one request per
   * destination.
   */
  private async splitMixedMetaPayloads(payloads: CachedPayload[]): Promise<CachedPayload[]> {
    const splits: Record<string, CachedPayload[]> = {};
    let found = false;
    for (const payload of payloads) {
      const runs = groupContiguousItemsByMeta(payload.items);
      if (payload.id && runs.length > 1) {
        found = true;
        splits[payload.id] = runs.map((items) => ({
          timestamp: payload.timestamp,
          items,
          ...(payload.deliveredTo && { deliveredTo: payload.deliveredTo }),
        }));
      }
    }
    if (!found) {
      return payloads;
    }
    await this.cache.replace(splits);
    return this.cache.readAll();
  }

  private async deliver(transport: Transport, items: TransportItem[], batched: boolean): Promise<DeliveryStatus> {
    try {
      if (!isDeliveryReporting(transport)) {
        await transport.send(batched ? items : (items[0] as TransportItem));
        return 'delivered';
      }

      const result = await transport.sendWithResult(items);
      if (result.outcome === 'accepted') {
        return 'delivered';
      }
      if (result.outcome === 'rejected' && isNonRetryableStatus(result.status)) {
        this.logWarn(`Dropping cached payload rejected by ${transport.name} with status ${result.status}`);
        return 'dropped';
      }
      return 'retry';
    } catch (error) {
      this.logDebug(`Replay through ${transport.name} failed: ${String(error)}`);
      return 'retry';
    }
  }

  /**
   * Returns the destinations replay sends to, or null when the default
   * transports are not known yet because this transport is not registered.
   */
  private getReplayTargets(): ReplayTarget[] | null {
    const registered = this.getRegisteredTransports();
    let candidates: Array<{ transport: Transport; key: string }>;

    if (this.explicitTargets) {
      candidates = [];
      for (const { transport, index } of this.explicitTargets) {
        const isRegistered = registered?.includes(transport) ?? false;
        if (isRegistered && !(transport instanceof FetchTransport)) {
          // It received every item live, cached ones included; replay would send them twice.
          if (!this.warnedSkippedTargets.has(transport)) {
            this.warnedSkippedTargets.add(transport);
            this.logWarn(
              `Not replaying offline payloads to ${transport.name}: it is registered with Faro and already received them`
            );
          }
          continue;
        }
        if (!isRegistered) {
          this.shareContextWith(transport);
        }
        candidates.push({ transport, key: getDestinationKey(transport) ?? `${transport.name}#${index}` });
      }
    } else {
      if (registered === null) {
        return null;
      }
      // Only FetchTransport skips claimed items live, so only it can replay without duplicates.
      candidates = registered
        .filter((transport): transport is FetchTransport => transport instanceof FetchTransport)
        .map((transport) => ({ transport, key: transport.getDestinationKey() }));
    }

    const targets: ReplayTarget[] = [];
    const seenKeys = new Set<string>();
    for (const { transport, key } of candidates) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        targets.push({ key, transport, batched: isBatchedSafe(transport) });
      }
    }
    return targets;
  }

  private getRegisteredTransports(): Transport[] | null {
    const transports = this.registeredTransports?.transports;
    if (!transports || !transports.includes(this)) {
      return null;
    }
    return transports;
  }

  /**
   * Transports passed to `setOtherTransports()` may not be registered with
   * Faro, so give them this transport's logger, config and metas if unset.
   */
  private shareContextWith(transport: Transport): void {
    if (!transport.internalLogger && this.internalLogger) {
      transport.internalLogger = this.internalLogger;
    }
    if (!transport.unpatchedConsole && this.unpatchedConsole) {
      transport.unpatchedConsole = this.unpatchedConsole;
    }
    if (!transport.config && this.config) {
      transport.config = this.config;
    }
    if (!transport.metas && this.metas) {
      transport.metas = this.metas;
    }
  }

  private scheduleRetry(result: ReplayPassResult): void {
    if (result.state !== 'pending') {
      if (result.state === 'done') {
        this.retryAttempt = 0;
      }
      return;
    }
    if (this.disposed || !this.connectivityService.isOnline) {
      return;
    }
    if (result.progressed) {
      this.retryAttempt = 0;
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

function isDeliveryReporting(transport: Transport): transport is DeliveryReportingTransport {
  return typeof (transport as Partial<DeliveryReportingTransport>).sendWithResult === 'function';
}

function getDestinationKey(transport: Transport): string | undefined {
  const reporting = transport as Partial<DeliveryReportingTransport>;
  if (typeof reporting.getDestinationKey === 'function') {
    return reporting.getDestinationKey();
  }
  return undefined;
}

function isBatchedSafe(transport: Transport): boolean {
  try {
    return transport.isBatched();
  } catch {
    return true;
  }
}

/**
 * Client errors other than timeout and rate limit mean the collector will not
 * accept the payload on retry either.
 */
function isNonRetryableStatus(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== HTTP_REQUEST_TIMEOUT &&
    status !== HTTP_TOO_MANY_REQUESTS
  );
}
