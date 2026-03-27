import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AsyncStorageUserPersistence,
  createUserPersistence,
  getUserPersistence,
  initializeUserPersistence,
  setUserPersistence,
} from './UserPersistence';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

describe('AsyncStorageUserPersistence', () => {
  let persistence: AsyncStorageUserPersistence;

  beforeEach(() => {
    jest.clearAllMocks();
    persistence = new AsyncStorageUserPersistence();
    setUserPersistence(null);
  });

  describe('loadUser', () => {
    it('should return null when no user is stored', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const user = await persistence.loadUser();

      expect(user).toBeNull();
    });

    it('should load stored user', async () => {
      const storedUser = { id: '123', email: 'test@example.com' };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(storedUser));

      const user = await persistence.loadUser();

      expect(user).toEqual(storedUser);
    });

    it('should return null on parse error', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('invalid json');

      const user = await persistence.loadUser();

      expect(user).toBeNull();
    });

    it('should return null on storage error', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('Storage error'));

      const user = await persistence.loadUser();

      expect(user).toBeNull();
    });
  });

  describe('saveUser', () => {
    it('should save user to storage', async () => {
      const user = { id: '123', email: 'test@example.com' };

      await persistence.saveUser(user);

      expect(AsyncStorage.setItem).toHaveBeenCalledWith('faro_persisted_user', JSON.stringify(user));
    });

    it('should clear user when null', async () => {
      await persistence.saveUser(null);

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith('faro_persisted_user');
    });

    it('should clear user when all fields empty', async () => {
      const clearedUser = { id: undefined, email: undefined };

      await persistence.saveUser(clearedUser);

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith('faro_persisted_user');
    });

    it('should handle storage error gracefully', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('Storage error'));

      // Should not throw
      await expect(persistence.saveUser({ id: '123' })).resolves.toBeUndefined();
    });
  });

  describe('clearUser', () => {
    it('should remove user from storage', async () => {
      await persistence.clearUser();

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith('faro_persisted_user');
    });

    it('should handle storage error gracefully', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('Storage error'));

      // Should not throw
      await expect(persistence.clearUser()).resolves.toBeUndefined();
    });
  });

  describe('hasPersistedUser', () => {
    it('should return true when user is stored', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{"id":"123"}');

      const hasUser = await persistence.hasPersistedUser();

      expect(hasUser).toBe(true);
    });

    it('should return false when no user is stored', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const hasUser = await persistence.hasPersistedUser();

      expect(hasUser).toBe(false);
    });

    it('should return false on storage error', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('Storage error'));

      const hasUser = await persistence.hasPersistedUser();

      expect(hasUser).toBe(false);
    });
  });

  describe('custom storage key', () => {
    it('should use custom storage key', async () => {
      const customPersistence = new AsyncStorageUserPersistence({ storageKey: 'custom_key' });

      await customPersistence.saveUser({ id: '123' });

      expect(AsyncStorage.setItem).toHaveBeenCalledWith('custom_key', expect.any(String));
    });
  });
});

describe('createUserPersistence', () => {
  it('should create a persistence instance', () => {
    const persistence = createUserPersistence();

    expect(persistence).toBeInstanceOf(AsyncStorageUserPersistence);
  });
});

describe('global persistence functions', () => {
  beforeEach(() => {
    setUserPersistence(null);
  });

  describe('initializeUserPersistence', () => {
    it('should initialize global persistence', () => {
      const persistence = initializeUserPersistence();

      expect(persistence).toBeDefined();
      expect(getUserPersistence()).toBe(persistence);
    });
  });

  describe('getUserPersistence', () => {
    it('should return null when not initialized', () => {
      expect(getUserPersistence()).toBeNull();
    });

    it('should return persistence when initialized', () => {
      initializeUserPersistence();

      expect(getUserPersistence()).not.toBeNull();
    });
  });

  describe('setUserPersistence', () => {
    it('should set custom persistence', () => {
      const mockPersistence = {
        loadUser: jest.fn(),
        saveUser: jest.fn(),
        clearUser: jest.fn(),
        hasPersistedUser: jest.fn(),
      };

      setUserPersistence(mockPersistence);

      expect(getUserPersistence()).toBe(mockPersistence);
    });

    it('should clear persistence when set to null', () => {
      initializeUserPersistence();
      setUserPersistence(null);

      expect(getUserPersistence()).toBeNull();
    });
  });
});
