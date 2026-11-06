import { NativeModules } from 'react-native';

import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import type { Meta } from '@grafana/faro-core';

import {
  minimalSessionDeviceAttributes,
  type PreloadedMobileMeta,
} from '../instrumentations/session/sessionAttributes';
import { defaultSessionTrackingConfig } from '../instrumentations/session/sessionManager/sessionConstants';
import { ConsoleTransport } from '../transports/console';
import { FetchTransport } from '../transports/fetch';
import { OfflineTransport } from '../transports/offline';

import { getRNInstrumentations } from './getRNInstrumentations';
import { makeRNConfig } from './makeRNConfig';
import type { ReactNativeConfig, ReactNativeFullConfig } from './types';

class ExtraInstrumentation extends BaseInstrumentation {
  readonly name = '@test/extra-instrumentation';
  readonly version = VERSION;

  initialize(): void {}
}

function disposeOfflineTransportsFromConfig(cfg: { transports?: unknown[] }): void {
  for (const t of cfg.transports ?? []) {
    if (t instanceof OfflineTransport) {
      t.dispose();
    }
  }
}

function metaValue(metas: ReactNativeFullConfig['metas']): Meta {
  return (metas ?? []).reduce<Meta>((acc, item) => Object.assign(acc, typeof item === 'function' ? item() : item), {});
}

describe('makeRNConfig', () => {
  const base: Pick<ReactNativeConfig, 'app' | 'url'> = {
    app: { name: 'test-app', version: '1.0.0' },
    url: 'https://faro.example.com/collect',
  };

  it('throws when url is missing', () => {
    expect(() =>
      makeRNConfig({
        app: base.app,
      } as ReactNativeConfig)
    ).toThrow('url is required');
  });

  it('builds OfflineTransport, FetchTransport, and optional ConsoleTransport in order', () => {
    const offlineFirst = makeRNConfig({
      ...base,
      enableTransports: { offline: true, console: false },
    });
    try {
      expect(offlineFirst.transports?.[0]).toBeInstanceOf(OfflineTransport);
      expect(offlineFirst.transports?.[1]).toBeInstanceOf(FetchTransport);

      const withConsole = makeRNConfig({
        ...base,
        enableTransports: { offline: true, console: true },
      });
      try {
        expect(withConsole.transports?.[0]).toBeInstanceOf(OfflineTransport);
        expect(withConsole.transports?.[1]).toBeInstanceOf(FetchTransport);
        expect(withConsole.transports?.[2]).toBeInstanceOf(ConsoleTransport);
      } finally {
        disposeOfflineTransportsFromConfig(withConsole);
      }
    } finally {
      disposeOfflineTransportsFromConfig(offlineFirst);
    }
  });

  it('defaults to FetchTransport only when enableTransports omitted', () => {
    const cfg = makeRNConfig({ ...base });
    expect(cfg.transports).toHaveLength(1);
    expect(cfg.transports?.[0]).toBeInstanceOf(FetchTransport);
  });

  it('appends extra transports after built-ins', () => {
    const marker = { transport: 'extra' } as unknown as NonNullable<ReactNativeConfig['transports']>[number];
    const cfg = makeRNConfig({
      ...base,
      enableTransports: { console: true },
      transports: [marker],
    });
    expect(cfg.transports?.[0]).toBeInstanceOf(FetchTransport);
    expect(cfg.transports?.[1]).toBeInstanceOf(ConsoleTransport);
    expect(cfg.transports?.[2]).toBe(marker);
  });

  it('appends extra instrumentations after getRNInstrumentations', () => {
    const extra = new ExtraInstrumentation();
    const cfg = makeRNConfig({
      ...base,
      instrumentations: [extra],
    });
    const names = cfg.instrumentations?.map((i) => i.name) ?? [];
    expect(names.at(-1)).toBe(extra.name);
  });

  describe('dynamicDeviceState', () => {
    const originalNativeModule = NativeModules.FaroReactNativeModule;
    const nativeState = { batteryLevel: 85, thermalState: 'fair', connectionType: 'wifi' };

    afterEach(() => {
      NativeModules.FaroReactNativeModule = originalNativeModule;
    });

    it('collects every group by default', () => {
      NativeModules.FaroReactNativeModule = { getDynamicDeviceState: jest.fn(() => nativeState) };

      const meta = metaValue(makeRNConfig(base).metas) as Meta & { network?: unknown };

      expect(meta.device).toEqual({ battery_level: 85, thermal_state: 'fair' });
      expect(meta.network).toEqual({ connection_type: 'wifi' });
    });

    it('omits the fields of a group that is off', () => {
      NativeModules.FaroReactNativeModule = { getDynamicDeviceState: jest.fn(() => nativeState) };

      const meta = metaValue(
        makeRNConfig({ ...base, dynamicDeviceState: { battery: false, network: false } }).metas
      ) as Meta & { network?: unknown };

      expect(meta.device).toEqual({ thermal_state: 'fair' });
      expect(meta.network).toBeUndefined();
    });

    it('does not read the native module when every group is off', () => {
      const read = jest.fn(() => nativeState);
      NativeModules.FaroReactNativeModule = { getDynamicDeviceState: read };

      metaValue(
        makeRNConfig({ ...base, dynamicDeviceState: { battery: false, thermal: false, network: false } }).metas
      );

      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    it('keeps batching disabled when not configured', () => {
      const cfg = makeRNConfig({ ...base });
      expect(cfg.batching).toEqual({ enabled: false, sendTimeout: 250, itemLimit: 50 });
    });

    it.each([
      { name: 'count triggers first', batching: { enabled: true, sendTimeout: 10_000, itemLimit: 2 } },
      { name: 'timer triggers first', batching: { enabled: true, sendTimeout: 100, itemLimit: 2_000 } },
      { name: 'two-second batching', batching: { enabled: true, sendTimeout: 2_000, itemLimit: 200 } },
    ])('uses supplied batching options ($name)', ({ batching }) => {
      const cfg = makeRNConfig({ ...base, batching });
      expect(cfg.batching).toEqual(batching);
    });

    it('fills omitted batching options with defaults', () => {
      const cfg = makeRNConfig({ ...base, batching: { enabled: true } });
      expect(cfg.batching).toEqual({ enabled: true, sendTimeout: 250, itemLimit: 50 });
    });
  });

  it('merges sessionTracking defaults with user overrides', () => {
    const cfg = makeRNConfig({
      ...base,
      sessionTracking: {
        persistent: true,
      },
    });
    expect(cfg.sessionTracking).toMatchObject({
      ...defaultSessionTrackingConfig,
      persistent: true,
    });
  });

  it('enables minimal session persistence by default', () => {
    const cfg = makeRNConfig({ ...base });

    expect(cfg.sessionTracking?.persistent).toBe(true);
  });

  it('uses getRNInstrumentations for the instrumentation set from flags', () => {
    const minimal = makeRNConfig({
      ...base,
      enableErrorReporting: false,
    });
    const direct = getRNInstrumentations({ enableErrorReporting: false });

    expect(minimal.instrumentations?.length).toBe(direct.length);
    expect(minimal.instrumentations?.map((i) => i.name)).toEqual(direct.map((i) => i.name));
  });

  it('passes preloaded mobile meta and flat session device attributes to core config', () => {
    const preloaded = minimalSessionDeviceAttributes();
    preloaded.device_id = 'test-preloaded-id';
    const preloadedMobileMeta: PreloadedMobileMeta = {
      sessionAttributes: preloaded,
      meta: {
        app: {
          installationId: 'test-installation-id',
        },
        device: {
          is_physical: true,
          model_identifier: 'iPhone16,1',
        },
        os: {
          name: 'iOS',
          version: '17.0',
        },
      },
    };

    const cfg = makeRNConfig({ ...base }, preloadedMobileMeta);

    expect(cfg.app.name).toBe('test-app');
    expect(cfg.app.installationId).toBe('test-installation-id');
    expect(cfg.preloadedMobileMeta).toEqual(preloadedMobileMeta.meta);
    expect(
      (cfg as { preloadedSessionDeviceAttributes?: { device_id: string } }).preloadedSessionDeviceAttributes
    ).toBeDefined();
    expect(
      (cfg as { preloadedSessionDeviceAttributes?: { device_id: string } }).preloadedSessionDeviceAttributes?.device_id
    ).toBe('test-preloaded-id');
    expect(cfg.metas).toContainEqual({
      os: {
        name: 'iOS',
        version: '17.0',
      },
    });
    expect(metaValue(cfg.metas).device).toEqual({
      is_physical: true,
      model_identifier: 'iPhone16,1',
    });
  });

  it('keeps explicit config app installationId over preloaded installationId', () => {
    const cfg = makeRNConfig(
      {
        ...base,
        app: {
          ...base.app,
          installationId: 'explicit-installation-id',
        },
      },
      {
        sessionAttributes: minimalSessionDeviceAttributes(),
        meta: {
          app: {
            installationId: 'preloaded-installation-id',
          },
        },
      }
    );

    expect(cfg.app.installationId).toBe('explicit-installation-id');
  });

  it('uses releaseBundleFilename in default parseStacktrace when set', () => {
    const cfg = makeRNConfig({
      ...base,
      releaseBundleFilename: 'main.jsbundle',
    });
    const err = new Error('x');
    err.stack = 'g@1:2';
    const parsed = cfg.parseStacktrace?.(err);
    expect(parsed?.frames?.[0]?.filename).toBe('main.jsbundle');
  });
});
