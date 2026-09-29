import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import type { PowerState } from 'react-native-device-info';

import type { Meta } from '@grafana/faro-core';

import { getInstallationId } from './installationId';
import { isConnectedToPower } from './powerSource';
import { getSessionProcessInfo } from './sessionProcess';

/**
 * Session attributes for React Native
 * These attributes are automatically included with every telemetry event
 *
 * Core mobile session attributes, with additional monitoring fields
 * (memory, device type, battery, etc.)
 *
 * SDK name and version are on Faro meta `sdk` (`getSdkMeta` in `metas/sdk.ts`).
 *
 * `react_native_version` is the host app's React Native **framework** version from `Platform`, not the Faro package.
 */
export interface SessionAttributes {
  /** Host app's React Native framework version (e.g. "0.75.1") from `Platform.constants`. */
  react_native_version: string;

  /** Stable Android process name or Apple bundle identifier for this runtime. */
  process_name?: string;

  /** Operating system ("iOS" or "Android") */
  device_os?: string;

  /** OS version (e.g., "17.0" for iOS, "15" for Android) */
  device_os_version?: string;

  /** Detailed OS info (e.g., "iOS 17.0" or "Android 15 (SDK 35)") */
  device_os_detail?: string;

  /** Device manufacturer, same value as `meta.device.manufacturer` (e.g., "apple", "samsung", "Google") */
  device_manufacturer?: string;

  /** Raw model identifier, same value as `meta.device.model_identifier` (e.g., "iPhone17,1", "SM-A155F") */
  device_model?: string;

  /**
   * Human-readable model name, same value as `meta.device.model_name` (e.g., "iPhone 16 Pro").
   * Android reports `Build.MODEL`. Omitted when the iOS identifier is not known to `react-native-device-info`.
   */
  device_model_name?: string;

  /** Device brand, same value as `meta.device.brand` (e.g., "Apple", "samsung") */
  device_brand?: string;

  /** Whether device is physical or emulator ("true" or "false") */
  device_is_physical?: string;

  /** Temporary flat attribute mirroring `app.installationId` during migration. */
  device_id?: string;

  /** Device type ("mobile" or "tablet") */
  device_type?: string;

  /** Total device memory in bytes */
  device_memory_total?: string;

  /** Memory used by the app process in bytes, not by the whole device */
  device_memory_used?: string;

  /** Battery level percentage at SDK start (e.g., "85") - empty if unavailable */
  device_battery_level?: string;

  /**
   * Whether the device is connected to external power at SDK start ("true" or "false"), including when the
   * battery is full or charging is paused - empty if unavailable
   */
  device_is_charging?: string;

  /** Whether iOS Low Power Mode or Android Battery Saver is on at SDK start ("true" or "false") - empty if unavailable */
  device_low_power_mode?: string;

  /** Mobile carrier name (e.g., "Verizon") - empty if unavailable, which is always the case on iOS 16.4 and later */
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

// Matches the Faro Flutter SDK: lowercase "apple" on iOS, raw Build.MANUFACTURER on Android.
function getDeviceManufacturer(manufacturer: string): string {
  return Platform.OS === 'ios' ? manufacturer.toLowerCase() : manufacturer;
}

// getModel() returns a bare family name when its table has no entry for the identifier.
const APPLE_MODEL_FALLBACK_NAMES = new Set(['iPhone', 'iPad', 'iPod Touch', 'Apple TV', 'Apple Vision', 'unknown']);

function getDeviceModelName(model: string): string | undefined {
  if (Platform.OS === 'ios' && APPLE_MODEL_FALLBACK_NAMES.has(model)) {
    return undefined;
  }

  return model;
}

function getDeviceModelIdentifier(model: string): string | undefined {
  // Android getDeviceId() returns a board code, so use Build.MODEL for the Faro
  // model identifier.
  if (Platform.OS === 'android') {
    return model;
  }

  // React Native reports iPhone and iPadOS apps as Platform.OS === 'ios'.
  // react-native-device-info exposes the Apple hardware identifier here.
  if (Platform.OS === 'ios') {
    return DeviceInfo.getDeviceId();
  }

  return undefined;
}

function getMobileDeviceType(isTablet: boolean): 'mobile' | 'tablet' | undefined {
  // iPadOS is still reported as Platform.OS === 'ios'; DeviceInfo.isTablet()
  // distinguishes iPad/tablet form factor from phone form factor.
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    return isTablet ? 'tablet' : 'mobile';
  }

  return undefined;
}

/**
 * Get OS detail string for session attributes.
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

interface DevicePowerAttributes {
  batteryLevel?: string;
  isCharging?: string;
  lowPowerMode?: string;
}

function isChargingFromBatteryState(batteryState: unknown): boolean | undefined {
  if (batteryState === 'charging' || batteryState === 'full') {
    return true;
  }

  return batteryState === 'unplugged' ? false : undefined;
}

async function getPowerState(): Promise<Partial<PowerState>> {
  try {
    // Android resolves null when the battery broadcast is unavailable.
    return (await DeviceInfo.getPowerState()) ?? {};
  } catch (_error) {
    return {};
  }
}

async function getDevicePowerAttributes(): Promise<DevicePowerAttributes> {
  const [{ batteryLevel, batteryState, lowPowerMode }, connectedToPower] = await Promise.all([
    getPowerState(),
    isConnectedToPower(),
  ]);
  const isCharging = connectedToPower ?? isChargingFromBatteryState(batteryState);

  return {
    batteryLevel:
      typeof batteryLevel === 'number' && batteryLevel >= 0 && batteryLevel <= 1
        ? String(Math.round(batteryLevel * 100))
        : undefined,
    isCharging: isCharging === undefined ? undefined : String(isCharging),
    lowPowerMode: typeof lowPowerMode === 'boolean' ? String(lowPowerMode) : undefined,
  };
}

// Apple deprecated CTCarrier, so iOS 16.4 and later return "--" for every carrier.
const UNAVAILABLE_CARRIER_NAMES = new Set(['', '--', 'unknown']);

async function getCarrier(): Promise<string | undefined> {
  try {
    const carrierName = await DeviceInfo.getCarrier();
    const trimmedCarrierName = typeof carrierName === 'string' ? carrierName.trim() : '';
    return UNAVAILABLE_CARRIER_NAMES.has(trimmedCarrierName) ? undefined : trimmedCarrierName;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Session attributes without device props when async collection or DeviceInfo is unavailable.
 * No synchronous DeviceInfo reads — use {@link getSessionAttributes} or the package async `initializeFaro`.
 */
export function minimalSessionDeviceAttributes(): SessionAttributes {
  const processInfo = getSessionProcessInfo();
  return {
    react_native_version: getReactNativeVersion(),
    ...(processInfo == null ? {} : { process_name: processInfo.identifier }),
  };
}

/**
 * Get all session attributes
 * These attributes are automatically included with every telemetry event
 *
 * Core session attributes:
 * - react_native_version (RN framework in the host app)
 * - process_name (Android process name or iOS bundle identifier)
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
    const modelIdentifier = getDeviceModelIdentifier(model);
    const modelName = getDeviceModelName(model);
    const brand = DeviceInfo.getBrand();
    const isEmulator = DeviceInfo.isEmulatorSync();
    const isTablet = DeviceInfo.isTablet();
    const deviceType = getMobileDeviceType(isTablet);
    const deviceManufacturer = getDeviceManufacturer(manufacturer);

    // Memory info
    const totalMemory = DeviceInfo.getTotalMemorySync();
    const usedMemory = DeviceInfo.getUsedMemorySync();

    const [power, carrier] = await Promise.all([getDevicePowerAttributes(), getCarrier()]);

    const attributes: SessionAttributes = {
      ...minimalSessionDeviceAttributes(),
      device_os: systemName,
      device_os_version: systemVersion,
      device_os_detail: deviceOsDetail,
      device_manufacturer: deviceManufacturer,
      device_model: modelIdentifier ?? model,
      device_model_name: modelName,
      device_brand: brand,
      device_is_physical: String(!isEmulator),
      ...(installationId ? { device_id: installationId } : {}),
      ...(deviceType ? { device_type: deviceType } : {}),
      device_memory_total: String(totalMemory),
      device_memory_used: String(usedMemory),
      device_battery_level: power.batteryLevel,
      device_is_charging: power.isCharging,
      device_low_power_mode: power.lowPowerMode,
      device_carrier: carrier,
    };
    const appMeta = installationId ? { installationId } : {};
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
          brand,
          is_physical: !isEmulator,
          manufacturer: deviceManufacturer,
          ...(modelIdentifier ? { model_identifier: modelIdentifier } : {}),
          ...(modelName ? { model_name: modelName } : {}),
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
