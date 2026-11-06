import { NativeModules, Platform } from 'react-native';

import type { Meta, MetaDevice } from '@grafana/faro-core';

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export type ConnectionType = 'wifi' | 'cell' | 'wired' | 'unavailable' | 'unknown';

/**
 * Dynamic `meta.device` fields of the mobile metadata contract. Each signal carries the value
 * that was current when it was captured.
 */
export interface DynamicMetaDevice {
  /** Battery level as a whole percent from 0 to 100 */
  battery_level?: number;

  /** Whether the device is connected to power (AC, USB or wireless), charging or full */
  is_charging?: boolean;

  /** Whether Android Battery Saver or iOS Low Power Mode is on */
  low_power_mode?: boolean;

  thermal_state?: ThermalState;
}

/**
 * `meta.network` of the mobile metadata contract. Every field is dynamic.
 */
export interface MetaNetwork {
  /** OpenTelemetry `network.connection.type` */
  connection_type?: ConnectionType;

  /** Cellular technology as OpenTelemetry `network.connection.subtype` names it, for example "lte" or "nr" */
  connection_subtype?: string;

  /** Mobile carrier name. Android only. */
  carrier_name?: string;
}

export interface DynamicDeviceState {
  device: DynamicMetaDevice;
  network: MetaNetwork;
}

/**
 * The groups of dynamic fields an app can turn off. A group that is off is not collected: its
 * native listeners never start and none of its fields reach a signal.
 *
 * - `battery`: `device.battery_level`, `device.is_charging` and `device.low_power_mode`
 * - `thermal`: `device.thermal_state`
 * - `network`: `network.connection_type`, `network.connection_subtype` and `network.carrier_name`
 */
export interface DynamicDeviceStateGroups {
  battery: boolean;
  thermal: boolean;
  network: boolean;
}

/** The `dynamicDeviceState` config option. A group is on unless its value is `false`. */
export type DynamicDeviceStateOptions = Partial<DynamicDeviceStateGroups>;

export function resolveDynamicDeviceStateGroups(options?: DynamicDeviceStateOptions): DynamicDeviceStateGroups {
  return {
    battery: options?.battery !== false,
    thermal: options?.thermal !== false,
    network: options?.network !== false,
  };
}

export function hasEnabledDynamicDeviceStateGroup(groups: DynamicDeviceStateGroups): boolean {
  return groups.battery || groups.thermal || groups.network;
}

/** The longest a native read is reused. It bounds the bridge calls, not the age of a value: native listeners keep their cache current. */
export const DYNAMIC_DEVICE_STATE_TTL_MS = 5000;

const DYNAMIC_DEVICE_KEYS = ['battery_level', 'is_charging', 'low_power_mode', 'thermal_state'] as const;

const THERMAL_STATES: ReadonlySet<string> = new Set<ThermalState>(['nominal', 'fair', 'serious', 'critical']);
const CONNECTION_TYPES: ReadonlySet<string> = new Set<ConnectionType>([
  'wifi',
  'cell',
  'wired',
  'unavailable',
  'unknown',
]);

function asPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asOneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Reads the map the native module returns. A value of the wrong type or range is dropped on its
 * own, so one bad field never costs the others. A group that is off is dropped even when native
 * code returns it, for example when an earlier initialization started that group.
 */
export function parseDynamicDeviceState(
  native: unknown,
  groups: DynamicDeviceStateGroups = resolveDynamicDeviceStateGroups()
): DynamicDeviceState {
  const raw = typeof native === 'object' && native !== null ? (native as Record<string, unknown>) : {};

  return {
    device: withoutUndefined({
      battery_level: groups.battery ? asPercent(raw['batteryLevel']) : undefined,
      is_charging: groups.battery ? asBoolean(raw['isCharging']) : undefined,
      low_power_mode: groups.battery ? asBoolean(raw['lowPowerMode']) : undefined,
      thermal_state: groups.thermal ? asOneOf<ThermalState>(raw['thermalState'], THERMAL_STATES) : undefined,
    }),
    network: withoutUndefined({
      connection_type: groups.network ? asOneOf<ConnectionType>(raw['connectionType'], CONNECTION_TYPES) : undefined,
      connection_subtype: groups.network ? asText(raw['connectionSubtype']) : undefined,
      // Apple deprecated the carrier API, so iOS never reports a carrier on any version.
      carrier_name: groups.network && Platform.OS === 'android' ? asText(raw['carrierName']) : undefined,
    }),
  };
}

interface DynamicDeviceStateNativeModule {
  startDynamicDeviceState?: (battery: boolean, thermal: boolean, network: boolean) => void;
  getDynamicDeviceState?: () => unknown;
}

/**
 * Starts the native listeners of the enabled groups. A group that is off starts nothing, and with
 * every group off the native module is not called. Never throws.
 */
export function startDynamicDeviceState(groups: DynamicDeviceStateGroups): void {
  if (!hasEnabledDynamicDeviceStateGroup(groups)) {
    return;
  }

  try {
    const nativeModule = NativeModules['FaroReactNativeModule'] as DynamicDeviceStateNativeModule | undefined;
    if (typeof nativeModule?.startDynamicDeviceState === 'function') {
      nativeModule.startDynamicDeviceState(groups.battery, groups.thermal, groups.network);
    }
  } catch {
    // Without the listeners the values are omitted.
  }
}

// A synchronous read of a cache the native listeners keep current. It does no I/O on the JS thread.
function readNativeDynamicDeviceState(groups?: DynamicDeviceStateGroups): DynamicDeviceState | undefined {
  const nativeModule = NativeModules['FaroReactNativeModule'] as DynamicDeviceStateNativeModule | undefined;
  if (typeof nativeModule?.getDynamicDeviceState !== 'function') {
    return undefined;
  }

  const native = nativeModule.getDynamicDeviceState();
  return native == null ? undefined : parseDynamicDeviceState(native, groups);
}

/**
 * Serves the dynamic device and network values from memory and re-reads the native cache at most
 * once per time-to-live. Never throws.
 */
export class DynamicDeviceStateProvider {
  private state: DynamicDeviceState | undefined;
  private readAt: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeToLiveMs: number = DYNAMIC_DEVICE_STATE_TTL_MS,
    private readonly read: () => DynamicDeviceState | undefined = () => readNativeDynamicDeviceState()
  ) {}

  get current(): DynamicDeviceState | undefined {
    const now = this.now();
    if (this.readAt !== undefined && now >= this.readAt && now - this.readAt <= this.timeToLiveMs) {
      return this.state;
    }

    try {
      this.state = this.read();
    } catch {
      this.state = undefined;
    }
    this.readAt = now;

    return this.state;
  }
}

/**
 * A meta item for the `device` and `network` slices. Faro core evaluates it each time it builds a
 * signal's meta, so every signal carries the values that are current when it is captured, and no
 * object that a captured signal references is ever changed.
 *
 * Core merges meta items shallowly, so this item supplies the complete `device` object: the static
 * fields given here plus the dynamic ones.
 *
 * With every group off the item serves the static fields and never reads the native module.
 */
export function getDynamicDeviceStateMeta(
  staticDevice: MetaDevice | undefined,
  groups: DynamicDeviceStateGroups = resolveDynamicDeviceStateGroups(),
  provider: DynamicDeviceStateProvider = new DynamicDeviceStateProvider(Date.now, DYNAMIC_DEVICE_STATE_TTL_MS, () =>
    readNativeDynamicDeviceState(groups)
  )
): () => Partial<Meta> {
  const enabled = hasEnabledDynamicDeviceStateGroup(groups);

  return () => {
    const state = enabled ? provider.current : undefined;
    const device = { ...staticDevice, ...state?.device };
    const hasNetwork = state !== undefined && Object.keys(state.network).length > 0;

    return {
      ...(Object.keys(device).length > 0 ? { device } : {}),
      ...(hasNetwork ? { network: { ...state.network } } : {}),
    } as Partial<Meta>;
  };
}

/** Returns a copy of `device` without the dynamic fields. */
export function omitDynamicDeviceFields<T extends MetaDevice>(device: T): T {
  const stable = { ...device } as Record<string, unknown>;
  for (const key of DYNAMIC_DEVICE_KEYS) {
    delete stable[key];
  }

  return stable as T;
}
