import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DataCollectionPolicy, DataCollectionPolicyOptions } from './types';

/**
 * Default storage key for the data collection policy.
 */
const DEFAULT_STORAGE_KEY = 'faro_enable_data_collection';

/**
 * DataCollectionPolicy implementation using AsyncStorage.
 *
 * Controls whether telemetry data is collected and sent.
 * The setting is persisted to AsyncStorage so it survives app restarts.
 *
 * Implementation follows Flutter SDK's DataCollectionPolicy pattern:
 * - Uses AsyncStorage for persistence (matching Flutter's SharedPreferences)
 * - Provides enable/disable methods
 * - Initializes from persisted value or default
 *
 * @example
 * ```typescript
 * import { createDataCollectionPolicy } from '@grafana/faro-react-native';
 *
 * // Create and initialize the policy
 * const policy = await createDataCollectionPolicy();
 *
 * // Check if enabled
 * if (policy.isEnabled) {
 *   // Data collection is allowed
 * }
 *
 * // User opts out
 * await policy.disable();
 *
 * // User opts back in
 * await policy.enable();
 * ```
 */
export class AsyncStorageDataCollectionPolicy implements DataCollectionPolicy {
  private _isEnabled: boolean;
  private readonly storageKey: string;
  private readonly subscribers: Set<(isEnabled: boolean) => void> = new Set();

  private constructor(options: DataCollectionPolicyOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this._isEnabled = options.defaultEnabled ?? true;
  }

  /**
   * Create and initialize a DataCollectionPolicy.
   *
   * This async factory method loads the persisted value from AsyncStorage.
   */
  static async create(options: DataCollectionPolicyOptions = {}): Promise<AsyncStorageDataCollectionPolicy> {
    const policy = new AsyncStorageDataCollectionPolicy(options);
    await policy.initialize();
    return policy;
  }

  get isEnabled(): boolean {
    return this._isEnabled;
  }

  async enable(): Promise<void> {
    this._isEnabled = true;
    await this.persistSetting();
    this.notifySubscribers();
  }

  async disable(): Promise<void> {
    this._isEnabled = false;
    await this.persistSetting();
    this.notifySubscribers();
  }

  subscribe(callback: (isEnabled: boolean) => void): () => void {
    this.subscribers.add(callback);
    // Immediately notify subscriber of current state
    callback(this._isEnabled);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async initialize(): Promise<void> {
    try {
      const storedValue = await AsyncStorage.getItem(this.storageKey);
      if (storedValue !== null) {
        this._isEnabled = storedValue === 'true';
      }
    } catch {
      // If loading fails, use default value
    }
  }

  private async persistSetting(): Promise<void> {
    try {
      await AsyncStorage.setItem(this.storageKey, String(this._isEnabled));
    } catch {
      // If persisting fails, log but don't throw
    }
  }

  private notifySubscribers(): void {
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(this._isEnabled);
      } catch {
        // Ignore subscriber errors
      }
    });
  }
}

/**
 * Factory function to create a DataCollectionPolicy.
 *
 * @example
 * ```typescript
 * const policy = await createDataCollectionPolicy();
 * ```
 */
export async function createDataCollectionPolicy(
  options: DataCollectionPolicyOptions = {}
): Promise<DataCollectionPolicy> {
  return AsyncStorageDataCollectionPolicy.create(options);
}

/**
 * Global data collection policy instance.
 * Must be initialized before use.
 */
let globalPolicy: DataCollectionPolicy | null = null;

/**
 * Initialize the global data collection policy.
 *
 * This should be called early in app initialization, before initializeFaro().
 *
 * @example
 * ```typescript
 * import { initializeDataCollectionPolicy, getDataCollectionPolicy } from '@grafana/faro-react-native';
 *
 * // Early in app startup
 * await initializeDataCollectionPolicy();
 *
 * // Later, check if collection is enabled
 * const policy = getDataCollectionPolicy();
 * if (policy?.isEnabled) {
 *   // Initialize Faro
 * }
 * ```
 */
export async function initializeDataCollectionPolicy(
  options: DataCollectionPolicyOptions = {}
): Promise<DataCollectionPolicy> {
  globalPolicy = await createDataCollectionPolicy(options);
  return globalPolicy;
}

/**
 * Get the global data collection policy.
 *
 * Returns null if not initialized.
 */
export function getDataCollectionPolicy(): DataCollectionPolicy | null {
  return globalPolicy;
}

/**
 * Set a custom data collection policy.
 *
 * Useful for testing or custom implementations.
 */
export function setDataCollectionPolicy(policy: DataCollectionPolicy | null): void {
  globalPolicy = policy;
}
