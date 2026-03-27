import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import { defaultSessionTrackingConfig } from '../instrumentations/session/sessionManager/sessionConstants';
import { ConsoleTransport } from '../transports/console';
import { FetchTransport } from '../transports/fetch';
import { OfflineTransport } from '../transports/offline';

import { getRNInstrumentations } from './getRNInstrumentations';
import { makeRNConfig } from './makeRNConfig';
import type { ReactNativeConfig } from './types';

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

  it('uses getRNInstrumentations for the instrumentation set from flags', () => {
    const minimal = makeRNConfig({
      ...base,
      enableErrorReporting: false,
    });
    const direct = getRNInstrumentations({ enableErrorReporting: false });

    expect(minimal.instrumentations?.length).toBe(direct.length);
    expect(minimal.instrumentations?.map((i) => i.name)).toEqual(direct.map((i) => i.name));
  });
});
