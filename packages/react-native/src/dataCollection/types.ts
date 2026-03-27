/**
 * Interface for data collection policy management.
 *
 * Controls whether telemetry data is collected and sent.
 * Useful for GDPR compliance and user privacy controls.
 */
export interface DataCollectionPolicy {
  /**
   * Whether data collection is currently enabled.
   */
  readonly isEnabled: boolean;

  /**
   * Enable telemetry data collection.
   */
  enable(): Promise<void>;

  /**
   * Disable telemetry data collection.
   */
  disable(): Promise<void>;

  /**
   * Subscribe to policy changes.
   * @param callback Function called when policy changes.
   * @returns Unsubscribe function.
   */
  subscribe(callback: (isEnabled: boolean) => void): () => void;
}

/**
 * Options for creating a DataCollectionPolicy.
 */
export interface DataCollectionPolicyOptions {
  /**
   * Storage key for persisting the policy setting.
   * Default: 'faro_enable_data_collection'
   */
  storageKey?: string;

  /**
   * Initial enabled state if no persisted value exists.
   * Default: true
   */
  defaultEnabled?: boolean;
}
