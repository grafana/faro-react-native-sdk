import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';

import type { Meta } from '@grafana/faro-core';

import { getInstallationId } from './installationId';

/**
 * Session attributes for React Native
 * These attributes are automatically included with every telemetry event
 *
 * Core attributes match Flutter SDK format, with additional mobile-specific
 * monitoring fields (memory, device type, battery, etc.)
 *
 * SDK name, core version, and npm adapter are on Faro meta `sdk` (`getSdkMeta` in `metas/sdk.ts`).
 *
 * `react_native_version` is the host app's React Native **framework** version from `Platform`, not the Faro package.
 */
export interface SessionAttributes {
  /** Host app's React Native framework version (e.g. "0.75.1") from `Platform.constants`. */
  react_native_version: string;

  /** Operating system ("iOS" or "Android") */
  device_os?: string;

  /** OS version (e.g., "17.0" for iOS, "15" for Android) */
  device_os_version?: string;

  /** Detailed OS info (e.g., "iOS 17.0" or "Android 15 (SDK 35)") */
  device_os_detail?: string;

  /** Device manufacturer (e.g., "apple", "samsung", "Google") */
  device_manufacturer?: string;

  /** Device model in flat session attributes (e.g., "iPhone 15 Pro", "SM-A155F") */
  device_model?: string;

  /** Human-readable model name (e.g., "iPhone 15 Pro") */
  device_model_name?: string;

  /** Device brand in flat session attributes (e.g., "Apple", "samsung") */
  device_brand?: string;

  /** Whether device is physical or emulator ("true" or "false") */
  device_is_physical?: string;

  /** Temporary flat attribute mirroring `app.installationId` during migration. */
  device_id?: string;

  /** Device type ("mobile" or "tablet") */
  device_type?: string;

  /** Total device memory in bytes */
  device_memory_total?: string;

  /** Currently used memory in bytes */
  device_memory_used?: string;

  /** Battery level percentage (e.g., "85") - empty if unavailable */
  device_battery_level?: string;

  /** Whether device is charging ("true" or "false") - empty if unavailable */
  device_is_charging?: string;

  /** Whether low power mode is enabled ("true" or "false") - empty if unavailable */
  device_low_power_mode?: string;

  /** Mobile carrier name (e.g., "Verizon") - empty if unavailable */
  device_carrier?: string;
}

export interface PreloadedMobileMeta {
  sessionAttributes: SessionAttributes;
  meta: Pick<Meta, 'app' | 'device' | 'os'>;
}

/**
 * React Native framework version from `Platform.constants` (host app runtime), not `@grafana/faro-react-native` semver.
 */
function getReactNativeVersion(): string {
  try {
    const version = Platform.constants.reactNativeVersion;
    if (version && typeof version === 'object') {
      const { major, minor, patch, prerelease } = version as {
        major: number;
        minor: number;
        patch: number;
        prerelease?: number;
      };
      let versionString = `${major}.${minor}.${patch}`;
      if (prerelease) {
        versionString += `-rc.${prerelease}`;
      }
      return versionString;
    }
    return 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function getStructuredDeviceBrand(model: string, brand: string): string {
  if (Platform.OS !== 'ios') {
    return brand;
  }

  return model.toLowerCase().includes('ipad') ? 'iPad' : 'iPhone';
}

function getStructuredDeviceManufacturer(manufacturer: string): string {
  return Platform.OS === 'ios' ? manufacturer.toLowerCase() : manufacturer;
}

function getStructuredDeviceModelIdentifier(model: string): string | undefined {
  // iOS device-info exposes the hardware identifier here. On Android the same
  // API returns a board code, so use Build.MODEL for the Faro model identifier.
  if (Platform.OS === 'ios') {
    return DeviceInfo.getDeviceId();
  }

  if (Platform.OS === 'android') {
    return model;
  }

  return undefined;
}

function getMobileDeviceType(isTablet: boolean): 'mobile' | 'tablet' | undefined {
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    return isTablet ? 'tablet' : 'mobile';
  }

  return undefined;
}

/**
 * Get OS detail string matching Flutter SDK format
 * iOS: "iOS 17.0"
 * Android: "Android 15 (SDK 35)"
 */
async function getDeviceOsDetail(): Promise<string> {
  const systemName = DeviceInfo.getSystemName();
  const systemVersion = DeviceInfo.getSystemVersion();

  if (Platform.OS === 'android') {
    try {
      const apiLevel = await DeviceInfo.getApiLevel();
      return `${systemName} ${systemVersion} (SDK ${apiLevel})`;
    } catch (_error) {
      return `${systemName} ${systemVersion}`;
    }
  }

  return `${systemName} ${systemVersion}`;
}

async function getDeviceOsBuildId(): Promise<string | undefined> {
  try {
    // RN device-info exposes a useful OS build id on both Android and iOS.
    // Keep it omitted when unavailable instead of sending "unknown".
    const buildId = await DeviceInfo.getBuildId();
    return buildId && buildId !== 'unknown' ? buildId : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Session attributes without device props when async collection or DeviceInfo is unavailable.
 * No synchronous DeviceInfo reads — use {@link getSessionAttributes} or the package async `initializeFaro`.
 */
export function minimalSessionDeviceAttributes(): SessionAttributes {
  return {
    react_native_version: getReactNativeVersion(),
  };
}

/**
 * Get all session attributes
 * These attributes are automatically included with every telemetry event
 *
 * Core attributes matching Flutter SDK:
 * - react_native_version (RN framework in the host app)
 * - device_os, device_os_version, device_os_detail
 * - device_manufacturer, device_model, device_model_name
 * - device_brand, device_is_physical, device_id
 *
 * Additional monitoring attributes:
 * - device_type (mobile/tablet)
 * - device_memory_total, device_memory_used
 * - device_battery_level, device_is_charging, device_low_power_mode
 * - device_carrier
 */
export async function getSessionAttributes(): Promise<SessionAttributes> {
  return (await collectMobileMeta()).sessionAttributes;
}

async function collectMobileMeta(): Promise<PreloadedMobileMeta> {
  try {
    const [deviceOsDetail, deviceOsBuildId, installationId] = await Promise.all([
      getDeviceOsDetail(),
      getDeviceOsBuildId(),
      getInstallationId(),
    ]);

    // Get synchronous device info
    const systemName = DeviceInfo.getSystemName();
    const systemVersion = DeviceInfo.getSystemVersion();
    const manufacturer = DeviceInfo.getManufacturerSync();
    const model = DeviceInfo.getModel();
    const modelIdentifier = getStructuredDeviceModelIdentifier(model);
    const deviceName = DeviceInfo.getDeviceNameSync();
    const brand = DeviceInfo.getBrand();
    const isEmulator = DeviceInfo.isEmulatorSync();
    const isTablet = DeviceInfo.isTablet();
    const deviceType = getMobileDeviceType(isTablet);

    // Memory info
    const totalMemory = DeviceInfo.getTotalMemorySync();
    const usedMemory = DeviceInfo.getUsedMemorySync();
    const reactNativeVersion = getReactNativeVersion();

    // Try to get async device info (battery, carrier)
    let batteryLevel: string | undefined;
    let isCharging: string | undefined;
    let lowPowerMode: string | undefined;
    let carrier: string | undefined;

    try {
      const battery = await DeviceInfo.getBatteryLevel();
      if (battery >= 0) {
        batteryLevel = String(Math.round(battery * 100));
      }
    } catch (_error) {
      // Battery info not available
    }

    try {
      isCharging = String(await DeviceInfo.isBatteryCharging());
    } catch (_error) {
      // Charging status not available
    }

    try {
      if ('isPowerSaveMode' in DeviceInfo) {
        lowPowerMode = String(
          await (DeviceInfo as typeof DeviceInfo & { isPowerSaveMode: () => Promise<boolean> }).isPowerSaveMode()
        );
      }
    } catch (_error) {
      // Low power mode not available
    }

    try {
      const carrierName = await DeviceInfo.getCarrier();
      if (carrierName && carrierName !== 'unknown') {
        carrier = carrierName;
      }
    } catch (_error) {
      // Carrier not available
    }

    const attributes: SessionAttributes = {
      react_native_version: reactNativeVersion,
      device_os: systemName,
      device_os_version: systemVersion,
      device_os_detail: deviceOsDetail,
      device_manufacturer: manufacturer.toLowerCase(),
      device_model: model,
      device_model_name: deviceName,
      device_brand: brand,
      device_is_physical: String(!isEmulator),
      ...(installationId ? { device_id: installationId } : {}),
      ...(deviceType ? { device_type: deviceType } : {}),
      device_memory_total: String(totalMemory),
      device_memory_used: String(usedMemory),
      device_battery_level: batteryLevel,
      device_is_charging: isCharging,
      device_low_power_mode: lowPowerMode,
      device_carrier: carrier,
    };
    const appMeta = installationId ? { installationId } : {};
    const structuredDeviceBrand = getStructuredDeviceBrand(model, brand);
    const structuredDeviceManufacturer = getStructuredDeviceManufacturer(manufacturer);
    const osMeta = {
      ...(deviceOsBuildId ? { build_id: deviceOsBuildId } : {}),
      detail: deviceOsDetail,
      name: systemName,
      version: systemVersion,
    };

    return {
      sessionAttributes: attributes,
      meta: {
        app: appMeta,
        device: {
          brand: structuredDeviceBrand,
          is_physical: !isEmulator,
          manufacturer: structuredDeviceManufacturer,
          ...(modelIdentifier ? { model_identifier: modelIdentifier } : {}),
          model_name: model,
          ...(deviceType ? { type: deviceType } : {}),
        },
        os: osMeta,
      },
    };
  } catch (_error) {
    const installationId = await getInstallationId();

    return {
      sessionAttributes: minimalSessionDeviceAttributes(),
      meta: {
        app: installationId ? { installationId } : {},
      },
    };
  }
}

/**
 * Get structured mobile meta plus flat session attributes for async `initializeFaro`.
 */
export async function loadMobileMetaForInit(): Promise<PreloadedMobileMeta> {
  return collectMobileMeta();
}

/**
 * Await full async session device attributes (battery, carrier, etc.), then fall back to
 * {@link minimalSessionDeviceAttributes} if anything throws. Used by async `initializeFaro`.
 */
export async function loadSessionDeviceAttributesForInit(): Promise<SessionAttributes> {
  try {
    return (await loadMobileMetaForInit()).sessionAttributes;
  } catch {
    return minimalSessionDeviceAttributes();
  }
}
