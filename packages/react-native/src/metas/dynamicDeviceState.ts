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
 * The longest a native read is reused. Faro core evaluates the meta item on every `metas.value`
 * access, several times per signal, so this bounds the synchronous bridge calls. It also bounds
 * how long a change that the native listeners already hold stays out of a signal.
 */
export const DYNAMIC_DEVICE_STATE_TTL_MS = 250;

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
 * own, so one bad field never costs the others.
 */
export function parseDynamicDeviceState(native: unknown): DynamicDeviceState {
  const raw = typeof native === 'object' && native !== null ? (native as Record<string, unknown>) : {};

  return {
    device: withoutUndefined({
      battery_level: asPercent(raw['batteryLevel']),
      is_charging: asBoolean(raw['isCharging']),
      low_power_mode: asBoolean(raw['lowPowerMode']),
      thermal_state: asOneOf<ThermalState>(raw['thermalState'], THERMAL_STATES),
    }),
    network: withoutUndefined({
      connection_type: asOneOf<ConnectionType>(raw['connectionType'], CONNECTION_TYPES),
      connection_subtype: asText(raw['connectionSubtype']),
      // Apple deprecated the carrier API, so iOS never reports a carrier on any version.
      carrier_name: Platform.OS === 'android' ? asText(raw['carrierName']) : undefined,
    }),
  };
}

interface DynamicDeviceStateNativeModule {
  getDynamicDeviceState?: () => unknown;
}

// A blocking call that returns a cache the native listeners keep current. Native does no system calls for it.
function readNativeDynamicDeviceState(): DynamicDeviceState | undefined {
  const nativeModule = NativeModules['FaroReactNativeModule'] as DynamicDeviceStateNativeModule | undefined;
  if (typeof nativeModule?.getDynamicDeviceState !== 'function') {
    return undefined;
  }

  const native = nativeModule.getDynamicDeviceState();
  return native == null ? undefined : parseDynamicDeviceState(native);
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
    private readonly read: () => DynamicDeviceState | undefined = readNativeDynamicDeviceState
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

const sharedProvider = new DynamicDeviceStateProvider();

/**
 * A meta item for the `device` and `network` slices. Faro core evaluates it each time it builds a
 * signal's meta, so every signal carries the values that are current when it is captured, and no
 * object that a captured signal references is ever changed.
 *
 * Core merges meta items shallowly, so this item supplies the complete `device` object: the static
 * fields given here plus the dynamic ones.
 */
export function getDynamicDeviceStateMeta(
  staticDevice: MetaDevice | undefined,
  provider: DynamicDeviceStateProvider = sharedProvider
): () => Partial<Meta> {
  return () => {
    const state = provider.current;
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
