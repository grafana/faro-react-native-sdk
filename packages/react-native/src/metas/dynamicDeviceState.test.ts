import { NativeModules, Platform } from 'react-native';

import {
  DYNAMIC_DEVICE_STATE_TTL_MS,
  DynamicDeviceStateProvider,
  getDynamicDeviceStateMeta,
  omitDynamicDeviceFields,
  parseDynamicDeviceState,
} from './dynamicDeviceState';
import type { DynamicDeviceState } from './dynamicDeviceState';

const originalNativeModule = NativeModules.FaroReactNativeModule;
const originalOS = Platform.OS;

function setPlatform(os: 'ios' | 'android'): void {
  (Platform as { OS: string }).OS = os;
}

afterEach(() => {
  NativeModules.FaroReactNativeModule = originalNativeModule;
  setPlatform(originalOS as 'ios' | 'android');
});

describe('parseDynamicDeviceState', () => {
  it('maps the native map to the typed meta fields', () => {
    setPlatform('android');

    expect(
      parseDynamicDeviceState({
        batteryLevel: 85,
        isCharging: true,
        lowPowerMode: false,
        thermalState: 'serious',
        connectionType: 'cell',
        connectionSubtype: 'lte',
        carrierName: ' Verizon ',
      })
    ).toEqual({
      device: { battery_level: 85, is_charging: true, low_power_mode: false, thermal_state: 'serious' },
      network: { connection_type: 'cell', connection_subtype: 'lte', carrier_name: 'Verizon' },
    });
  });

  it('keeps false values', () => {
    setPlatform('android');

    expect(parseDynamicDeviceState({ isCharging: false, lowPowerMode: false })).toEqual({
      device: { is_charging: false, low_power_mode: false },
      network: {},
    });
  });

  it('drops a value of the wrong type or range without costing the others', () => {
    setPlatform('android');

    expect(
      parseDynamicDeviceState({
        batteryLevel: 101,
        isCharging: 'true',
        lowPowerMode: true,
        thermalState: 'hot',
        connectionType: 'satellite',
        connectionSubtype: '',
        carrierName: '   ',
      })
    ).toEqual({
      device: { low_power_mode: true },
      network: {},
    });
  });

  it.each([-1, 50.5, Number.NaN, '50', null])('drops the battery level %p', (batteryLevel) => {
    expect(parseDynamicDeviceState({ batteryLevel }).device).toEqual({});
  });

  it('never reports a carrier on iOS', () => {
    setPlatform('ios');

    expect(parseDynamicDeviceState({ carrierName: 'Verizon', connectionType: 'cell' }).network).toEqual({
      connection_type: 'cell',
    });
  });

  it.each([undefined, null, 'text', 5])('returns empty groups for %p', (native) => {
    expect(parseDynamicDeviceState(native)).toEqual({ device: {}, network: {} });
  });
});

describe('DynamicDeviceStateProvider', () => {
  const state: DynamicDeviceState = { device: { battery_level: 50 }, network: {} };

  it('reads once per time-to-live', () => {
    let now = 1000;
    const read = jest.fn(() => state);
    const provider = new DynamicDeviceStateProvider(() => now, DYNAMIC_DEVICE_STATE_TTL_MS, read);

    expect(provider.current).toBe(state);
    now += DYNAMIC_DEVICE_STATE_TTL_MS;
    expect(provider.current).toBe(state);
    expect(read).toHaveBeenCalledTimes(1);

    now += 1;
    expect(provider.current).toBe(state);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again when the clock moves backwards', () => {
    let now = 10_000;
    const read = jest.fn(() => state);
    const provider = new DynamicDeviceStateProvider(() => now, DYNAMIC_DEVICE_STATE_TTL_MS, read);

    expect(provider.current).toBe(state);
    now = 1000;
    expect(provider.current).toBe(state);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves nothing and does not throw when the read throws', () => {
    const provider = new DynamicDeviceStateProvider(
      () => 0,
      DYNAMIC_DEVICE_STATE_TTL_MS,
      () => {
        throw new Error('bridge down');
      }
    );

    expect(provider.current).toBeUndefined();
  });

  it('reads the native module by default', () => {
    setPlatform('android');
    NativeModules.FaroReactNativeModule = {
      getDynamicDeviceState: jest.fn(() => ({ batteryLevel: 40, connectionType: 'wifi' })),
    };

    expect(new DynamicDeviceStateProvider().current).toEqual({
      device: { battery_level: 40 },
      network: { connection_type: 'wifi' },
    });
  });

  it.each([
    ['the native module is missing', undefined],
    ['the method is missing', {}],
    ['the native module returns null', { getDynamicDeviceState: jest.fn(() => null) }],
    [
      'the native call throws',
      {
        getDynamicDeviceState: jest.fn(() => {
          throw new Error('unavailable');
        }),
      },
    ],
  ])('serves nothing when %s', (_case, nativeModule) => {
    NativeModules.FaroReactNativeModule = nativeModule;

    expect(new DynamicDeviceStateProvider().current).toBeUndefined();
  });
});

describe('getDynamicDeviceStateMeta', () => {
  function providerFor(read: () => DynamicDeviceState | undefined): DynamicDeviceStateProvider {
    return new DynamicDeviceStateProvider(() => 0, DYNAMIC_DEVICE_STATE_TTL_MS, read);
  }

  it('merges the dynamic values into the static device and adds the network', () => {
    const getMeta = getDynamicDeviceStateMeta(
      { is_physical: true, model_identifier: 'iPhone16,1' },
      providerFor(() => ({
        device: { battery_level: 80, thermal_state: 'fair' },
        network: { connection_type: 'wifi' },
      }))
    );

    expect(getMeta()).toEqual({
      device: { is_physical: true, model_identifier: 'iPhone16,1', battery_level: 80, thermal_state: 'fair' },
      network: { connection_type: 'wifi' },
    });
  });

  it('returns a new object each time, so a captured signal is never changed', () => {
    const getMeta = getDynamicDeviceStateMeta(
      { is_physical: true },
      providerFor(() => ({ device: { battery_level: 80 }, network: { connection_type: 'wifi' } }))
    );

    const first = getMeta() as { device: object; network: object };
    const second = getMeta() as { device: object; network: object };

    expect(first.device).not.toBe(second.device);
    expect(first.network).not.toBe(second.network);
  });

  it('follows the native values as they change', () => {
    let level = 80;
    let now = 0;
    const provider = new DynamicDeviceStateProvider(
      () => now,
      DYNAMIC_DEVICE_STATE_TTL_MS,
      () => ({ device: { battery_level: level }, network: {} })
    );
    const getMeta = getDynamicDeviceStateMeta(undefined, provider);

    expect(getMeta()).toEqual({ device: { battery_level: 80 } });

    level = 79;
    now += DYNAMIC_DEVICE_STATE_TTL_MS + 1;

    expect(getMeta()).toEqual({ device: { battery_level: 79 } });
  });

  it('keeps only the static device when no dynamic value is available', () => {
    const getMeta = getDynamicDeviceStateMeta(
      { is_physical: false },
      providerFor(() => undefined)
    );

    expect(getMeta()).toEqual({ device: { is_physical: false } });
  });

  it('returns nothing without static or dynamic values', () => {
    expect(
      getDynamicDeviceStateMeta(
        undefined,
        providerFor(() => undefined)
      )()
    ).toEqual({});
  });

  it('omits an empty network', () => {
    const getMeta = getDynamicDeviceStateMeta(
      undefined,
      providerFor(() => ({ device: { is_charging: false }, network: {} }))
    );

    expect(getMeta()).toEqual({ device: { is_charging: false } });
  });
});

describe('omitDynamicDeviceFields', () => {
  it('removes only the dynamic fields without changing the input', () => {
    const device = {
      brand: 'Apple',
      is_physical: true,
      battery_level: 50,
      is_charging: true,
      low_power_mode: false,
      thermal_state: 'nominal' as const,
    };

    expect(omitDynamicDeviceFields(device)).toEqual({ brand: 'Apple', is_physical: true });
    expect(device.battery_level).toBe(50);
  });
});
