import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AsyncStorageDataCollectionPolicy,
  createDataCollectionPolicy,
  getDataCollectionPolicy,
  initializeDataCollectionPolicy,
  setDataCollectionPolicy,
} from './DataCollectionPolicy';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}));

describe('AsyncStorageDataCollectionPolicy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDataCollectionPolicy(null);
  });

  describe('create', () => {
    it('should create with default enabled state', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const policy = await AsyncStorageDataCollectionPolicy.create();

      expect(policy.isEnabled).toBe(true);
    });

    it('should load persisted disabled state', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('false');

      const policy = await AsyncStorageDataCollectionPolicy.create();

      expect(policy.isEnabled).toBe(false);
    });

    it('should load persisted enabled state', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

      const policy = await AsyncStorageDataCollectionPolicy.create();

      expect(policy.isEnabled).toBe(true);
    });

    it('should use custom default when no persisted value', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const policy = await AsyncStorageDataCollectionPolicy.create({
        defaultEnabled: false,
      });

      expect(policy.isEnabled).toBe(false);
    });

    it('should use custom storage key', async () => {
      const customKey = 'custom_key';
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      await AsyncStorageDataCollectionPolicy.create({
        storageKey: customKey,
      });

      expect(AsyncStorage.getItem).toHaveBeenCalledWith(customKey);
    });
  });

  describe('enable', () => {
    it('should enable collection and persist', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('false');

      const policy = await AsyncStorageDataCollectionPolicy.create();
      expect(policy.isEnabled).toBe(false);

      await policy.enable();

      expect(policy.isEnabled).toBe(true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith('faro_enable_data_collection', 'true');
    });
  });

  describe('disable', () => {
    it('should disable collection and persist', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

      const policy = await AsyncStorageDataCollectionPolicy.create();
      expect(policy.isEnabled).toBe(true);

      await policy.disable();

      expect(policy.isEnabled).toBe(false);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith('faro_enable_data_collection', 'false');
    });
  });

  describe('subscribe', () => {
    it('should notify subscriber immediately with current state', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

      const policy = await AsyncStorageDataCollectionPolicy.create();
      const callback = jest.fn();

      policy.subscribe(callback);

      expect(callback).toHaveBeenCalledWith(true);
    });

    it('should notify subscriber on state change', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

      const policy = await AsyncStorageDataCollectionPolicy.create();
      const callback = jest.fn();

      policy.subscribe(callback);
      callback.mockClear();

      await policy.disable();

      expect(callback).toHaveBeenCalledWith(false);
    });

    it('should allow unsubscribing', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

      const policy = await AsyncStorageDataCollectionPolicy.create();
      const callback = jest.fn();

      const unsubscribe = policy.subscribe(callback);
      callback.mockClear();

      unsubscribe();

      await policy.disable();

      expect(callback).not.toHaveBeenCalled();
    });
  });
});

describe('createDataCollectionPolicy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a policy', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const policy = await createDataCollectionPolicy();

    expect(policy).toBeDefined();
    expect(policy.isEnabled).toBe(true);
  });
});

describe('global policy functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDataCollectionPolicy(null);
  });

  describe('initializeDataCollectionPolicy', () => {
    it('should initialize global policy', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const policy = await initializeDataCollectionPolicy();

      expect(policy).toBeDefined();
      expect(getDataCollectionPolicy()).toBe(policy);
    });
  });

  describe('getDataCollectionPolicy', () => {
    it('should return null when not initialized', () => {
      expect(getDataCollectionPolicy()).toBeNull();
    });

    it('should return policy when initialized', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      await initializeDataCollectionPolicy();

      expect(getDataCollectionPolicy()).not.toBeNull();
    });
  });

  describe('setDataCollectionPolicy', () => {
    it('should set custom policy', () => {
      const mockPolicy = {
        isEnabled: false,
        enable: jest.fn(),
        disable: jest.fn(),
        subscribe: jest.fn(),
      };

      setDataCollectionPolicy(mockPolicy);

      expect(getDataCollectionPolicy()).toBe(mockPolicy);
    });

    it('should clear policy when set to null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      await initializeDataCollectionPolicy();
      setDataCollectionPolicy(null);

      expect(getDataCollectionPolicy()).toBeNull();
    });
  });
});
