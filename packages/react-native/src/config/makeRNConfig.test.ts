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

  it('moves a user-supplied OfflineTransport before the network transports', () => {
    const marker = { transport: 'extra' } as unknown as NonNullable<ReactNativeConfig['transports']>[number];
    const offline = new OfflineTransport();
    try {
      const cfg = makeRNConfig({ ...base, transports: [marker, offline] });
      expect(cfg.transports?.[0]).toBe(offline);
      expect(cfg.transports?.[1]).toBeInstanceOf(FetchTransport);
      expect(cfg.transports?.[2]).toBe(marker);
    } finally {
      offline.dispose();
    }
  });

  describe('with an offline transport', () => {
    it('keeps the built-in OfflineTransport and disposes a supplied one', () => {
      const supplied = new OfflineTransport();
      const dispose = jest.spyOn(supplied, 'dispose');
      const cfg = makeRNConfig({ ...base, enableTransports: { offline: true }, transports: [supplied] });
      try {
        const offlines = (cfg.transports ?? []).filter((t) => t instanceof OfflineTransport);
        expect(offlines).toHaveLength(1);
        expect(offlines[0]).not.toBe(supplied);
        expect(dispose).toHaveBeenCalledTimes(1);
      } finally {
        disposeOfflineTransportsFromConfig(cfg);
      }
    });

    it('keeps the first of several supplied OfflineTransports and does not dispose one supplied twice', () => {
      const first = new OfflineTransport();
      const second = new OfflineTransport();
      const disposeFirst = jest.spyOn(first, 'dispose');
      const disposeSecond = jest.spyOn(second, 'dispose');
      const cfg = makeRNConfig({ ...base, transports: [first, second, first] });
      try {
        expect(cfg.transports?.[0]).toBe(first);
        expect((cfg.transports ?? []).filter((t) => t instanceof OfflineTransport)).toEqual([first]);
        expect(disposeFirst).not.toHaveBeenCalled();
        expect(disposeSecond).toHaveBeenCalledTimes(1);
      } finally {
        first.dispose();
      }
    });

    it('keeps a supplied FetchTransport for the same URL instead of the built-in one, and other URLs too', () => {
      const sameUrl = new FetchTransport({ url: base.url, apiKey: 'user-key' });
      const sameUrlAgain = new FetchTransport({ url: base.url });
      const otherUrl = new FetchTransport({ url: 'https://other.example.com/collect' });
      const cfg = makeRNConfig({
        ...base,
        enableTransports: { offline: true },
        transports: [sameUrl, otherUrl, sameUrlAgain],
      });
      try {
        expect(cfg.transports?.[0]).toBeInstanceOf(OfflineTransport);
        expect((cfg.transports ?? []).filter((t) => t instanceof FetchTransport)).toEqual([sameUrl, otherUrl]);
      } finally {
        disposeOfflineTransportsFromConfig(cfg);
      }
    });
  });

  it('keeps every FetchTransport without an offline transport', () => {
    const sameUrl = new FetchTransport({ url: base.url });
    const cfg = makeRNConfig({ ...base, transports: [sameUrl] });
    expect(cfg.transports).toHaveLength(2);
    expect(cfg.transports?.[0]).toBeInstanceOf(FetchTransport);
    expect(cfg.transports?.[1]).toBe(sameUrl);
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
