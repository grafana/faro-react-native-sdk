import type { ConnectivityService } from './types';

// Optional: used when the app has it installed.
let NetInfo: {
  fetch: () => Promise<{ isConnected: boolean | null }>;
  addEventListener: (callback: (state: { isConnected: boolean | null }) => void) => () => void;
} | null = null;

try {
  NetInfo = require('@react-native-community/netinfo').default;
} catch {
  // NetInfo not available: always reported online.
}

/**
 * Connectivity hint for the offline transport.
 *
 * With `@react-native-community/netinfo` installed, `isOnline` is false only
 * while NetInfo reports `isConnected === false`. Without it, `isOnline` is
 * always true and nothing is polled: whether telemetry is stored depends on
 * whether sending it succeeds.
 */
export class DefaultConnectivityService implements ConnectivityService {
  private _isOnline: boolean = true;
  private readonly subscribers: Set<(isOnline: boolean) => void> = new Set();
  private unsubscribeNetInfo: (() => void) | null = null;
  private disposed = false;
  private known: Promise<void> = Promise.resolve();

  /**
   * @param _checkIntervalMs Unused; kept for compatibility. Connectivity is no longer polled.
   */
  constructor(_checkIntervalMs?: number) {
    this.initializeWithNetInfo();
  }

  get isOnline(): boolean {
    return this._isOnline;
  }

  subscribe(callback: (isOnline: boolean) => void): () => void {
    this.subscribers.add(callback);
    // Immediately notify subscriber of current state
    callback(this._isOnline);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  whenKnown(): Promise<void> {
    return this.known;
  }

  dispose(): void {
    this.disposed = true;
    if (this.unsubscribeNetInfo) {
      this.unsubscribeNetInfo();
      this.unsubscribeNetInfo = null;
    }
    this.subscribers.clear();
  }

  private initializeWithNetInfo(): void {
    if (!NetInfo) {
      return;
    }

    let markKnown: () => void = () => {};
    const known = new Promise<void>((resolve) => {
      markKnown = resolve;
    });
    try {
      // Only `isConnected` is used: `isInternetReachable` is probed against a public URL.
      NetInfo.fetch()
        .then((state) => this.setOnline(state.isConnected !== false))
        .catch(() => undefined)
        .finally(markKnown);
      this.unsubscribeNetInfo = NetInfo.addEventListener((state) => {
        this.setOnline(state.isConnected !== false);
        markKnown();
      });
      this.known = known;
    } catch {
      // A broken NetInfo install must not break telemetry: stay online.
    }
  }

  private setOnline(isOnline: boolean): void {
    if (!this.disposed && this._isOnline !== isOnline) {
      this._isOnline = isOnline;
      this.notifySubscribers();
    }
  }

  private notifySubscribers(): void {
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(this._isOnline);
      } catch {
        // Ignore subscriber errors
      }
    });
  }
}
