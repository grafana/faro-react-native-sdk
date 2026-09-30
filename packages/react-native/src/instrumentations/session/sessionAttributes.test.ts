import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';

import { getSessionAttributes, loadMobileMetaForInit, minimalSessionDeviceAttributes } from './sessionAttributes';
import { resetSessionProcessForTests } from './sessionProcess';

const INSTALLATION_ID_STORAGE_KEY = '@grafana/faro-react-native/installation_id';
const STORED_INSTALLATION_ID = 'stored-installation-id';
const originalNativeModule = NativeModules.FaroReactNativeModule;
const sessionNativeModule = {
  claimSessionPersistence: () => true,
  getSessionProcessIdentifier: () => 'com.example.myapp',
  isMainSessionProcess: () => true,
  releaseSessionPersistence: () => true,
};

function setStoredInstallationId(value = STORED_INSTALLATION_ID): void {
  (global as any).mockAsyncStorage = {
    [INSTALLATION_ID_STORAGE_KEY]: value,
  };
}

// Mock react-native-device-info
jest.mock('react-native-device-info', () => ({
  getUniqueId: jest.fn(),
  getSystemName: jest.fn(),
  getSystemVersion: jest.fn(),
  getManufacturerSync: jest.fn(),
  getModel: jest.fn(),
  getDeviceId: jest.fn(),
  getDeviceNameSync: jest.fn(),
  getBrand: jest.fn(),
  isEmulatorSync: jest.fn(),
  isTablet: jest.fn(),
  getTotalMemorySync: jest.fn(),
  getUsedMemorySync: jest.fn(),
  getPowerState: jest.fn(),
  getCarrier: jest.fn(),
  getApiLevel: jest.fn(),
  getBuildId: jest.fn(),
}));

describe('sessionAttributes', () => {
  beforeEach(() => {
    (global as any).mockAsyncStorage = {};
    NativeModules.FaroReactNativeModule = sessionNativeModule;
    jest.clearAllMocks();
    resetSessionProcessForTests();
  });

  afterAll(() => {
    NativeModules.FaroReactNativeModule = originalNativeModule;
    resetSessionProcessForTests();
  });

  describe('getSessionAttributes', () => {
    describe('iOS', () => {
      beforeEach(() => {
        // Mock iOS platform
        (Platform as any).OS = 'ios';
        Object.defineProperty(Platform, 'constants', {
          value: {
            reactNativeVersion: {
              major: 0,
              minor: 75,
              patch: 1,
            },
          },
          writable: true,
        });
      });

      it('should collect all iOS device attributes', async () => {
        setStoredInstallationId();
        // Setup mocks for iOS device
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Vishwan's iPhone");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({
          batteryLevel: 0.85,
          batteryState: 'unplugged',
          lowPowerMode: false,
        });
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue('Verizon');

        const attributes = await getSessionAttributes();

        expect(attributes).toEqual({
          react_native_version: '0.75.1',
          process_name: 'com.example.myapp',
          device_os: 'iOS',
          device_os_version: '17.0',
          device_os_detail: 'iOS 17.0',
          device_manufacturer: 'apple',
          device_model: 'iPhone16,1',
          device_model_name: 'iPhone 15 Pro',
          device_brand: 'Apple',
          device_is_physical: 'true',
          device_id: STORED_INSTALLATION_ID,
          device_type: 'mobile',
          device_memory_total: '4000000000',
          device_memory_used: '2000000000',
          device_battery_level: '85',
          device_is_charging: 'false',
          device_low_power_mode: 'false',
          device_carrier: 'Verizon',
        });
      });

      it('should never report the user-assigned device name', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('15.8');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 13');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone14,5');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Vishwan's iPhone");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);

        const mobileMeta = await loadMobileMetaForInit();

        expect(DeviceInfo.getDeviceNameSync).not.toHaveBeenCalled();
        expect(JSON.stringify(mobileMeta)).not.toContain('Vishwan');
      });

      it('should report the marketing name for iPhone 16 Pro', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('27.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 16 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone17,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.sessionAttributes).toMatchObject({
          device_model: 'iPhone17,1',
          device_model_name: 'iPhone 16 Pro',
        });
        expect(mobileMeta.meta.device).toMatchObject({
          model_identifier: 'iPhone17,1',
          model_name: 'iPhone 16 Pro',
        });
      });

      it.each([
        ['iPhone', 'iPhone99,1'],
        ['iPad', 'iPad99,1'],
        ['iPod Touch', 'iPod99,1'],
        ['Apple TV', 'AppleTV99,1'],
        ['Apple Vision', 'RealityDevice99,1'],
        ['unknown', 'iPhone99,1'],
      ])(
        'should omit the model name when getModel() falls back to %p for unknown identifier %p',
        async (fallbackName, deviceId) => {
          (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
          (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('27.0');
          (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
          (DeviceInfo.getModel as jest.Mock).mockReturnValue(fallbackName);
          (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue(deviceId);
          (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
          (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
          (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);

          const mobileMeta = await loadMobileMetaForInit();

          expect(mobileMeta.sessionAttributes.device_model).toBe(deviceId);
          expect(mobileMeta.sessionAttributes.device_model_name).toBeUndefined();
          expect(mobileMeta.meta.device?.model_identifier).toBe(deviceId);
          expect(mobileMeta.meta.device).not.toHaveProperty('model_name');
        }
      );

      it('should identify emulator devices', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        // On a simulator getDeviceId() returns SIMULATOR_MODEL_IDENTIFIER, not the host architecture.
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(true);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(1000000000);

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_physical).toBe('false');
        expect(attributes.device_model).toBe('iPhone16,1');
        expect(attributes.device_model_name).toBe('iPhone 15 Pro');
      });

      it('should handle iOS with different OS versions', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('16.4');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 14 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone15,2');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(6000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(3000000000);

        const attributes = await getSessionAttributes();

        expect(attributes.device_os_version).toBe('16.4');
        expect(attributes.device_os_detail).toBe('iOS 16.4');
      });
    });

    describe('Android', () => {
      beforeEach(() => {
        // Mock Android platform
        (Platform as any).OS = 'android';
        Object.defineProperty(Platform, 'constants', {
          value: {
            reactNativeVersion: {
              major: 0,
              minor: 75,
              patch: 1,
            },
          },
          writable: true,
        });
      });

      it('should collect all Android device attributes', async () => {
        setStoredInstallationId();
        // Setup mocks for Android device
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('15');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('SM-A155F');
        // Android getDeviceId() is the board code; structured model_identifier should use Build.MODEL instead.
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('a15');
        // User-assigned Bluetooth/device name; must not be reported.
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Ben's Galaxy");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({
          batteryLevel: 0.85,
          batteryState: 'unplugged',
          lowPowerMode: false,
        });
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue('Verizon');
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(35);

        const attributes = await getSessionAttributes();

        expect(attributes).toEqual({
          react_native_version: '0.75.1',
          process_name: 'com.example.myapp',
          device_os: 'Android',
          device_os_version: '15',
          device_os_detail: 'Android 15 (SDK 35)',
          device_manufacturer: 'samsung',
          device_model: 'SM-A155F',
          device_model_name: 'SM-A155F',
          device_brand: 'samsung',
          device_is_physical: 'true',
          device_id: STORED_INSTALLATION_ID,
          device_type: 'mobile',
          device_memory_total: '8000000000',
          device_memory_used: '4000000000',
          device_battery_level: '85',
          device_is_charging: 'false',
          device_low_power_mode: 'false',
          device_carrier: 'Verizon',
        });
      });

      it('should identify Android emulator devices', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('13');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Google');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('sdk_gphone64_arm64');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('emu64a');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('google');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(true);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(1000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(33);

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_physical).toBe('false');
        expect(attributes.device_model).toBe('sdk_gphone64_arm64');
      });

      it('should handle Android without API level', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('12');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Xiaomi');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('M2101K7AG');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('camellia');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('xiaomi');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(6000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(3000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockRejectedValue(new Error('API level unavailable'));

        const attributes = await getSessionAttributes();

        // Should fallback to version without SDK level
        expect(attributes.device_os_detail).toBe('Android 12');
      });
    });

    describe('structured mobile meta', () => {
      beforeEach(() => {
        (Platform as any).OS = 'android';
        Object.defineProperty(Platform, 'constants', {
          value: {
            reactNativeVersion: {
              major: 0,
              minor: 75,
              patch: 1,
            },
          },
          writable: true,
        });
      });

      it('should collect structured app, device, and OS meta with flat session attributes', async () => {
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('15');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Samsung');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('SM-A155F');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('a15');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(true);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(35);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('AP3A.240905.015.A2');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.meta).toEqual({
          app: {
            installationId: STORED_INSTALLATION_ID,
          },
          device: {
            brand: 'samsung',
            is_physical: true,
            manufacturer: 'Samsung',
            model_identifier: 'SM-A155F',
            model_name: 'SM-A155F',
            type: 'tablet',
          },
          os: {
            build_id: 'AP3A.240905.015.A2',
            detail: 'Android 15 (SDK 35)',
            name: 'Android',
            version: '15',
          },
        });
        expect(mobileMeta.sessionAttributes).toMatchObject({
          device_id: STORED_INSTALLATION_ID,
          device_brand: 'samsung',
          device_manufacturer: 'Samsung',
          device_model: 'SM-A155F',
          device_model_name: 'SM-A155F',
          device_os: 'Android',
          device_os_detail: 'Android 15 (SDK 35)',
          device_type: 'tablet',
        });
        expect(AsyncStorage.getItem).toHaveBeenCalledWith(INSTALLATION_ID_STORAGE_KEY);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      });

      it('should collect iOS structured app, device, and OS meta with flat session attributes', async () => {
        (Platform as any).OS = 'ios';
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.2');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Vishwan's iPhone");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('21C62');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.meta).toEqual({
          app: {
            installationId: STORED_INSTALLATION_ID,
          },
          device: {
            brand: 'Apple',
            is_physical: true,
            manufacturer: 'apple',
            model_identifier: 'iPhone16,1',
            model_name: 'iPhone 15 Pro',
            type: 'mobile',
          },
          os: {
            build_id: '21C62',
            detail: 'iOS 17.2',
            name: 'iOS',
            version: '17.2',
          },
        });
        expect(mobileMeta.sessionAttributes).toMatchObject({
          device_id: STORED_INSTALLATION_ID,
          device_brand: 'Apple',
          device_manufacturer: 'apple',
          device_model: 'iPhone16,1',
          device_model_name: 'iPhone 15 Pro',
          device_os: 'iOS',
          device_os_detail: 'iOS 17.2',
          device_type: 'mobile',
        });
      });

      it('should classify iPad structured meta as iPad tablet', async () => {
        (Platform as any).OS = 'ios';
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iPadOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('18.1');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPad Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPad14,3');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(true);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(3000000000);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('22B83');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.meta.device).toMatchObject({
          brand: 'Apple',
          manufacturer: 'apple',
          model_identifier: 'iPad14,3',
          model_name: 'iPad Pro',
          type: 'tablet',
        });
        expect(mobileMeta.meta.os).toMatchObject({
          build_id: '22B83',
          detail: 'iPadOS 18.1',
          name: 'iPadOS',
          version: '18.1',
        });
      });

      it('should omit mobile/tablet type when running on a non-mobile React Native platform', async () => {
        (Platform as any).OS = 'macos';
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('macOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('15.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('MacBookPro18,3');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('MacBookPro18,3');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(16000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('24A335');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.sessionAttributes.device_type).toBeUndefined();
        expect(mobileMeta.meta.device).not.toHaveProperty('type');
      });

      it('should create and persist an SDK installation id when one does not exist yet', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('15');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Google');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('sdk_gphone64_arm64');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('emu64a');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('google');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(true);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(1000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(35);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('AP3A.240905.015.A2');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.meta.app?.installationId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
        expect(AsyncStorage.setItem).toHaveBeenCalledWith(
          INSTALLATION_ID_STORAGE_KEY,
          mobileMeta.meta.app?.installationId
        );
      });

      it('should keep installation id when DeviceInfo collection fails', async () => {
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get system name');
        });

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta).toEqual({
          sessionAttributes: {
            react_native_version: '0.75.1',
            process_name: 'com.example.myapp',
          },
          meta: {
            app: {
              installationId: STORED_INSTALLATION_ID,
            },
          },
        });
      });
    });

    describe('React Native version parsing', () => {
      it('should parse version with prerelease', () => {
        Object.defineProperty(Platform, 'constants', {
          value: {
            reactNativeVersion: {
              major: 0,
              minor: 76,
              patch: 0,
              prerelease: 1,
            },
          },
          writable: true,
        });

        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);

        return getSessionAttributes().then((attributes) => {
          expect(attributes.react_native_version).toBe('0.76.0-rc.1');
        });
      });

      it('should fallback to unknown if version unavailable', () => {
        Object.defineProperty(Platform, 'constants', {
          value: {},
          writable: true,
        });

        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);

        return getSessionAttributes().then((attributes) => {
          expect(attributes.react_native_version).toBe('unknown');
        });
      });
    });

    describe('Error handling', () => {
      it('should gracefully handle DeviceInfo errors and return fallback values', async () => {
        // Mock all DeviceInfo methods to throw errors
        (DeviceInfo.getSystemName as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get system name');
        });
        (DeviceInfo.getSystemVersion as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get system version');
        });
        (DeviceInfo.getManufacturerSync as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get manufacturer');
        });
        (DeviceInfo.getModel as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get model');
        });
        (DeviceInfo.getDeviceId as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get device id');
        });
        (DeviceInfo.getBrand as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get brand');
        });
        (DeviceInfo.isEmulatorSync as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to check emulator');
        });

        const attributes = await getSessionAttributes();

        // Device info is omitted when collection fails so nothing partial is sent to Faro
        expect(attributes).toEqual({
          react_native_version: expect.any(String),
          process_name: 'com.example.myapp',
        });
        expect(attributes.device_id).toBeUndefined();
        expect(attributes.device_os).toBeUndefined();
      });

      it('should handle partial DeviceInfo failures', async () => {
        // Some methods work, others fail
        // Note: If any method throws, the entire catch block returns fallback values
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockImplementation(() => {
          throw new Error('Manufacturer unavailable');
        });
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);

        const attributes = await getSessionAttributes();

        // Any synchronous DeviceInfo failure skips all device fields (minimal payload only)
        expect(attributes).toEqual({
          react_native_version: expect.any(String),
          process_name: 'com.example.myapp',
        });
        expect(attributes.device_id).toBeUndefined();
        expect(attributes.device_manufacturer).toBeUndefined();
        expect(attributes.device_model).toBeUndefined();
      });
    });

    describe('Manufacturer normalization', () => {
      beforeEach(() => {
        (Platform as any).OS = 'android';
      });

      it('should keep the Android manufacturer as reported', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('14');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('SAMSUNG');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('SM-G998B');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('p3s');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(12000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(6000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(34);

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.sessionAttributes.device_manufacturer).toBe('SAMSUNG');
        expect(mobileMeta.meta.device?.manufacturer).toBe('SAMSUNG');
      });

      it('should report one Android manufacturer value in flat and typed meta', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('14');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('OnePlus');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('LE2121');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('lemonade');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('OnePlus');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(34);

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.sessionAttributes.device_manufacturer).toBe('OnePlus');
        expect(mobileMeta.meta.device?.manufacturer).toBe('OnePlus');
      });

      it('should lowercase the iOS manufacturer in flat and typed meta', async () => {
        (Platform as any).OS = 'ios';
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 15 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone16,1');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.sessionAttributes.device_manufacturer).toBe('apple');
        expect(mobileMeta.meta.device?.manufacturer).toBe('apple');
      });
    });

    describe('Power and carrier', () => {
      function mockDevice(os: 'ios' | 'android'): void {
        (Platform as any).OS = os;
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue(os === 'ios' ? 'iOS' : 'Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue(os === 'ios' ? '27.0' : '16');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue(os === 'ios' ? 'Apple' : 'Google');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue(os === 'ios' ? 'iPhone 16 Pro' : 'Pixel 9');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue(os === 'ios' ? 'iPhone17,1' : 'tokay');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue(os === 'ios' ? 'Apple' : 'google');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(36);
      }

      it.each([
        ['charging', 'true'],
        ['full', 'true'],
        ['unplugged', 'false'],
        ['unknown', undefined],
      ])('should map iOS battery state %p to device_is_charging %p', async (batteryState, expected) => {
        mockDevice('ios');
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({ batteryLevel: 0.5, batteryState });

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_charging).toBe(expected);
      });

      it('should report low power mode from getPowerState', async () => {
        mockDevice('ios');
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({
          batteryLevel: 0.2,
          batteryState: 'unplugged',
          lowPowerMode: true,
        });

        const attributes = await getSessionAttributes();

        expect(attributes.device_low_power_mode).toBe('true');
        expect(attributes.device_battery_level).toBe('20');
      });

      it('should omit battery fields when the power state is unavailable', async () => {
        mockDevice('android');
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue(null);

        const attributes = await getSessionAttributes();

        expect(attributes.device_battery_level).toBeUndefined();
        expect(attributes.device_is_charging).toBeUndefined();
        expect(attributes.device_low_power_mode).toBeUndefined();
        expect(attributes.device_os).toBe('Android');
      });

      it('should omit the battery level when the simulator reports -1', async () => {
        mockDevice('ios');
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({
          batteryLevel: -1,
          batteryState: 'unknown',
          lowPowerMode: false,
        });

        const attributes = await getSessionAttributes();

        expect(attributes.device_battery_level).toBeUndefined();
        expect(attributes.device_is_charging).toBeUndefined();
        expect(attributes.device_low_power_mode).toBe('false');
      });

      it('should keep other device fields when getPowerState rejects', async () => {
        mockDevice('ios');
        (DeviceInfo.getPowerState as jest.Mock).mockRejectedValue(new Error('power state unavailable'));

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_charging).toBeUndefined();
        expect(attributes.device_model).toBe('iPhone17,1');
      });

      it('should report a plugged-in Android device as charging while charging is paused', async () => {
        mockDevice('android');
        NativeModules.FaroReactNativeModule = {
          ...sessionNativeModule,
          isConnectedToPower: jest.fn().mockResolvedValue(true),
        };
        // react-native-device-info reports BATTERY_STATUS_NOT_CHARGING while plugged in as "unknown".
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({
          batteryLevel: 0.8,
          batteryState: 'unknown',
          lowPowerMode: false,
        });

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_charging).toBe('true');
        expect(attributes.device_battery_level).toBe('80');
      });

      it('should prefer the native plug type over the battery state on Android', async () => {
        mockDevice('android');
        NativeModules.FaroReactNativeModule = {
          ...sessionNativeModule,
          isConnectedToPower: jest.fn().mockResolvedValue(false),
        };
        // The two reads can disagree when the cable is pulled between them.
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({ batteryLevel: 1, batteryState: 'full' });

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_charging).toBe('false');
      });

      it('should fall back to the battery state when the native plug type is unavailable', async () => {
        mockDevice('android');
        (DeviceInfo.getPowerState as jest.Mock).mockResolvedValue({ batteryLevel: 1, batteryState: 'full' });

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_charging).toBe('true');
        expect(attributes.device_battery_level).toBe('100');
      });

      it.each(['--', 'unknown', '', '   ', null])('should omit the placeholder carrier %p', async (carrierName) => {
        mockDevice('ios');
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue(carrierName);

        const attributes = await getSessionAttributes();

        expect(attributes.device_carrier).toBeUndefined();
      });

      it('should trim a real carrier name', async () => {
        mockDevice('android');
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue(' T-Mobile ');

        const attributes = await getSessionAttributes();

        expect(attributes.device_carrier).toBe('T-Mobile');
      });
    });

    it('omits process identity when the native bridge is unavailable', () => {
      const nativeModule = NativeModules.FaroReactNativeModule;
      NativeModules.FaroReactNativeModule = undefined;
      resetSessionProcessForTests();

      try {
        expect(minimalSessionDeviceAttributes()).toEqual({
          react_native_version: expect.any(String),
        });
      } finally {
        NativeModules.FaroReactNativeModule = nativeModule;
        resetSessionProcessForTests();
      }
    });
  });
});
