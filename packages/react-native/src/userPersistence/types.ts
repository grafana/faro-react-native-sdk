import type { MetaUser } from '@grafana/faro-core';

/**
 * Interface for user data persistence.
 *
 * Handles saving and loading user data between app sessions.
 */
export interface UserPersistence {
  /**
   * Load the persisted user from storage.
   * Returns null if no user has been persisted.
   */
  loadUser(): Promise<MetaUser | null>;

  /**
   * Save the user to storage.
   * If user is null or cleared, any previously persisted user data is cleared.
   */
  saveUser(user: MetaUser | null): Promise<void>;

  /**
   * Clear any persisted user data.
   */
  clearUser(): Promise<void>;

  /**
   * Check if there is persisted user data.
   */
  hasPersistedUser(): Promise<boolean>;
}

/**
 * Options for creating a UserPersistence instance.
 */
export interface UserPersistenceOptions {
  /**
   * Storage key for persisting user data.
   * Default: 'faro_persisted_user'
   */
  storageKey?: string;
}
