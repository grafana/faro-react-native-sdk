import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';

import { getSessionAttributes, loadMobileMetaForInit } from './sessionAttributes';

const INSTALLATION_ID_STORAGE_KEY = '@grafana/faro-react-native/installation_id';
const STORED_INSTALLATION_ID = 'stored-installation-id';

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
  getBatteryLevel: jest.fn(),
  isBatteryCharging: jest.fn(),
  getCarrier: jest.fn(),
  getApiLevel: jest.fn(),
  getBuildId: jest.fn(),
}));

describe('sessionAttributes', () => {
  beforeEach(() => {
    (global as any).mockAsyncStorage = {};
    jest.clearAllMocks();
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
        (DeviceInfo.getBatteryLevel as jest.Mock).mockResolvedValue(0.85);
        (DeviceInfo.isBatteryCharging as jest.Mock).mockResolvedValue(false);
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue('Verizon');

        const attributes = await getSessionAttributes();

        expect(attributes).toEqual({
          react_native_version: '0.75.1',
          device_os: 'iOS',
          device_os_version: '17.0',
          device_os_detail: 'iOS 17.0',
          device_manufacturer: 'apple',
          device_model: 'iPhone 15 Pro',
          device_model_name: "Vishwan's iPhone",
          device_brand: 'Apple',
          device_is_physical: 'true',
          device_id: STORED_INSTALLATION_ID,
          device_type: 'mobile',
          device_memory_total: '4000000000',
          device_memory_used: '2000000000',
          device_battery_level: '85',
          device_is_charging: 'false',
          device_low_power_mode: undefined,
          device_carrier: 'Verizon',
        });
      });

      it('should identify emulator devices', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('17.0');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone Simulator');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('x86_64');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('Test iPhone Simulator');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(true);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(2000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(1000000000);

        const attributes = await getSessionAttributes();

        expect(attributes.device_is_physical).toBe('false');
        expect(attributes.device_model_name).toBe('Test iPhone Simulator');
      });

      it('should handle iOS with different OS versions', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('16.4');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPhone 14 Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPhone15,2');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's iPhone");
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
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Samsung');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('SM-A155F');
        // Android getDeviceId() is the board code; structured model_identifier should use Build.MODEL instead.
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('a15');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('SM-A155F');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getBatteryLevel as jest.Mock).mockResolvedValue(0.85);
        (DeviceInfo.isBatteryCharging as jest.Mock).mockResolvedValue(false);
        (DeviceInfo.getCarrier as jest.Mock).mockResolvedValue('Verizon');
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(35);

        const attributes = await getSessionAttributes();

        expect(attributes).toEqual({
          react_native_version: '0.75.1',
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
          device_low_power_mode: undefined,
          device_carrier: 'Verizon',
        });
      });

      it('should identify Android emulator devices', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('13');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Google');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('sdk_gphone64_arm64');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('emu64a');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('Pixel 5');
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('M2101K7AG');
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('Galaxy A15');
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
          device_model: 'SM-A155F',
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
            brand: 'iPhone',
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
          device_model: 'iPhone 15 Pro',
          device_os: 'iOS',
          device_os_detail: 'iOS 17.2',
          device_type: 'mobile',
        });
        expect(mobileMeta.meta.device?.model_name).not.toContain('Vishwan');
      });

      it('should classify iPad structured meta as iPad tablet', async () => {
        (Platform as any).OS = 'ios';
        setStoredInstallationId();
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('iPadOS');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('18.1');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('iPad Pro');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('iPad14,3');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's iPad");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(true);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(3000000000);
        (DeviceInfo.getBuildId as jest.Mock).mockResolvedValue('22B83');

        const mobileMeta = await loadMobileMetaForInit();

        expect(mobileMeta.meta.device).toMatchObject({
          brand: 'iPad',
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's MacBook Pro");
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('Pixel 5');
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's iPhone");
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's iPhone");
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockImplementation(() => {
          throw new Error('Failed to get device name');
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
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue("Test's iPhone");
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('Apple');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);

        const attributes = await getSessionAttributes();

        // Any synchronous DeviceInfo failure skips all device fields (minimal payload only)
        expect(attributes).toEqual({
          react_native_version: expect.any(String),
        });
        expect(attributes.device_id).toBeUndefined();
        expect(attributes.device_manufacturer).toBeUndefined();
        expect(attributes.device_model).toBeUndefined();
      });
    });

    describe('Manufacturer normalization', () => {
      it('should lowercase manufacturer names', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('14');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('SAMSUNG');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('SM-G998B');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('p3s');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('Galaxy S21 Ultra');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('samsung');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(12000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(6000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(34);

        const attributes = await getSessionAttributes();

        expect(attributes.device_manufacturer).toBe('samsung');
      });

      it('should handle mixed case manufacturer names', async () => {
        (DeviceInfo.getSystemName as jest.Mock).mockReturnValue('Android');
        (DeviceInfo.getSystemVersion as jest.Mock).mockReturnValue('14');
        (DeviceInfo.getManufacturerSync as jest.Mock).mockReturnValue('OnePlus');
        (DeviceInfo.getModel as jest.Mock).mockReturnValue('LE2121');
        (DeviceInfo.getDeviceId as jest.Mock).mockReturnValue('lemonade');
        (DeviceInfo.getDeviceNameSync as jest.Mock).mockReturnValue('OnePlus 9 Pro');
        (DeviceInfo.getBrand as jest.Mock).mockReturnValue('OnePlus');
        (DeviceInfo.isEmulatorSync as jest.Mock).mockReturnValue(false);
        (DeviceInfo.isTablet as jest.Mock).mockReturnValue(false);
        (DeviceInfo.getTotalMemorySync as jest.Mock).mockReturnValue(8000000000);
        (DeviceInfo.getUsedMemorySync as jest.Mock).mockReturnValue(4000000000);
        (DeviceInfo.getApiLevel as jest.Mock).mockResolvedValue(34);

        const attributes = await getSessionAttributes();

        expect(attributes.device_manufacturer).toBe('oneplus');
      });
    });
  });
});
