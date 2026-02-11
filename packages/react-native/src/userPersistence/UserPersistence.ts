import type { MetaUser } from '@grafana/faro-core';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { UserPersistence, UserPersistenceOptions } from './types';

/**
 * Default storage key for user data.
 */
const DEFAULT_STORAGE_KEY = 'faro_persisted_user';

/**
 * UserPersistence implementation using AsyncStorage.
 *
 * Stores user information persistently so it can be restored on app restart.
 * This ensures early telemetry events include user identification.
 *
 * Implementation follows Flutter SDK's UserPersistence pattern:
 * - Uses AsyncStorage for persistence (matching Flutter's SharedPreferences)
 * - Stores user as JSON
 * - Handles null/cleared users
 *
 * @example
 * ```typescript
 * import { createUserPersistence } from '@grafana/faro-react-native';
 *
 * // Load user on app start
 * const persistence = createUserPersistence();
 * const user = await persistence.loadUser();
 *
 * if (user) {
 *   faro.api.setUser(user);
 * }
 *
 * // Save user when logged in
 * const loggedInUser = { id: '123', email: 'user@example.com' };
 * await persistence.saveUser(loggedInUser);
 *
 * // Clear on logout
 * await persistence.clearUser();
 * ```
 */
export class AsyncStorageUserPersistence implements UserPersistence {
  private readonly storageKey: string;

  constructor(options: UserPersistenceOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  async loadUser(): Promise<MetaUser | null> {
    try {
      const userJson = await AsyncStorage.getItem(this.storageKey);
      if (userJson === null) {
        return null;
      }

      const userData = JSON.parse(userJson);
      if (!this.isValidMetaUser(userData)) {
        return null;
      }

      return userData;
    } catch {
      return null;
    }
  }

  async saveUser(user: MetaUser | null): Promise<void> {
    try {
      if (user === null || this.isCleared(user)) {
        await this.clearUser();
        return;
      }

      const userJson = JSON.stringify(user);
      await AsyncStorage.setItem(this.storageKey, userJson);
    } catch {
      // Log failure but don't throw
    }
  }

  async clearUser(): Promise<void> {
    try {
      await AsyncStorage.removeItem(this.storageKey);
    } catch {
      // Log failure but don't throw
    }
  }

  async hasPersistedUser(): Promise<boolean> {
    try {
      const userJson = await AsyncStorage.getItem(this.storageKey);
      return userJson !== null;
    } catch {
      return false;
    }
  }

  /**
   * Check if user is cleared (all fields empty/undefined).
   */
  private isCleared(user: MetaUser): boolean {
    return !user.id && !user.email && !user.username && !user.fullName && !user.roles;
  }

  /**
   * Validate that the parsed object is a valid MetaUser.
   */
  private isValidMetaUser(obj: unknown): obj is MetaUser {
    if (typeof obj !== 'object' || obj === null) {
      return false;
    }

    // MetaUser has optional string fields, so any object is technically valid
    // We just need to make sure it's an object
    return true;
  }
}

/**
 * Factory function to create a UserPersistence instance.
 */
export function createUserPersistence(options: UserPersistenceOptions = {}): UserPersistence {
  return new AsyncStorageUserPersistence(options);
}

/**
 * Global user persistence instance.
 */
let globalUserPersistence: UserPersistence | null = null;

/**
 * Initialize the global user persistence.
 */
export function initializeUserPersistence(options: UserPersistenceOptions = {}): UserPersistence {
  globalUserPersistence = createUserPersistence(options);
  return globalUserPersistence;
}

/**
 * Get the global user persistence instance.
 */
export function getUserPersistence(): UserPersistence | null {
  return globalUserPersistence;
}

/**
 * Set a custom user persistence instance.
 */
export function setUserPersistence(persistence: UserPersistence | null): void {
  globalUserPersistence = persistence;
}
