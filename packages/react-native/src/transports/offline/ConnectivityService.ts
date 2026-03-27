import type { ConnectivityService } from './types';

// Try to use NetInfo if available, otherwise fall back to basic online detection
let NetInfo: {
  fetch: () => Promise<{ isConnected: boolean | null }>;
  addEventListener: (callback: (state: { isConnected: boolean | null }) => void) => () => void;
} | null = null;

try {
  NetInfo = require('@react-native-community/netinfo').default;
} catch {
  // NetInfo not available, will fall back to basic detection
}

/**
 * Default connectivity check interval in milliseconds.
 */
const DEFAULT_CHECK_INTERVAL_MS = 30000;

/**
 * Service for detecting network connectivity changes.
 *
 * Uses @react-native-community/netinfo when available, otherwise falls back
 * to basic fetch-based connectivity detection.
 *
 * Implementation follows Flutter SDK's InternetConnectivityService pattern.
 */
export class DefaultConnectivityService implements ConnectivityService {
  private _isOnline: boolean = true;
  private readonly subscribers: Set<(isOnline: boolean) => void> = new Set();
  private unsubscribeNetInfo: (() => void) | null = null;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;

  constructor(checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS) {
    this.checkIntervalMs = checkIntervalMs;
    this.initialize();
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

  dispose(): void {
    if (this.unsubscribeNetInfo) {
      this.unsubscribeNetInfo();
      this.unsubscribeNetInfo = null;
    }
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    this.subscribers.clear();
  }

  private initialize(): void {
    if (NetInfo) {
      this.initializeWithNetInfo();
    } else {
      this.initializeWithPolling();
    }
  }

  private initializeWithNetInfo(): void {
    if (!NetInfo) return;

    // Initial check
    NetInfo.fetch().then((state) => {
      this.setOnline(state.isConnected ?? true);
    });

    // Subscribe to changes
    this.unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      this.setOnline(state.isConnected ?? true);
    });
  }

  private initializeWithPolling(): void {
    // Initial check
    this.checkConnectivity();

    // Poll periodically
    this.checkIntervalId = setInterval(() => {
      this.checkConnectivity();
    }, this.checkIntervalMs);
  }

  private async checkConnectivity(): Promise<void> {
    try {
      // Simple fetch-based connectivity check
      // We use a small, fast endpoint
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      await fetch('https://one.one.one.one/cdn-cgi/trace', {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.setOnline(true);
    } catch {
      this.setOnline(false);
    }
  }

  private setOnline(isOnline: boolean): void {
    if (this._isOnline !== isOnline) {
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
