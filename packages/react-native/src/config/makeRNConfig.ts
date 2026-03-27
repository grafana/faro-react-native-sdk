import { defaultGlobalObjectKey, defaultUnpatchedConsole, InternalLoggerLevel, LogLevel } from '@grafana/faro-core';
import type { Config } from '@grafana/faro-core';

import { getStackFramesFromError } from '../instrumentations/errors/stackTraceParser';
import { defaultSessionTrackingConfig } from '../instrumentations/session/sessionManager/sessionConstants';
import { getPageMeta } from '../metas/page';
import { getScreenMeta } from '../metas/screen';
import { getSdkMeta } from '../metas/sdk';
import { ConsoleTransport } from '../transports/console';
import { FetchTransport } from '../transports/fetch';
import { OfflineTransport } from '../transports/offline';

import { getRNInstrumentations } from './getRNInstrumentations';
import type { ReactNativeConfig, ReactNativeSessionTrackingConfig } from './types';

const DEFAULT_OFFLINE_CACHE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Builds transports. FetchTransport is always added when url is provided.
 * User can enable offline and console via enableTransports.
 */
function buildTransports(config: ReactNativeConfig): Config['transports'] {
  const { enableTransports = { offline: false, console: false } } = config;

  if (!config.url) {
    throw new Error('url is required. Provide the Faro collector URL.');
  }

  const builtTransports: Config['transports'] = [];

  if (enableTransports.offline) {
    builtTransports.push(
      new OfflineTransport({
        maxCacheDurationMs: DEFAULT_OFFLINE_CACHE_MS,
      })
    );
  }

  builtTransports.push(
    new FetchTransport({
      url: config.url,
      apiKey: config.apiKey,
    })
  );

  if (enableTransports.console) {
    builtTransports.push(new ConsoleTransport({ level: LogLevel.DEBUG }));
  }

  const extraTransports = config.transports ?? [];
  return [...builtTransports, ...extraTransports];
}

/**
 * Builds instrumentations from config flags.
 */
function buildInstrumentations(config: ReactNativeConfig): Config['instrumentations'] {
  const baseInstrumentations = getRNInstrumentations(config);
  const extraInstrumentations = config.instrumentations ?? [];
  return [...baseInstrumentations, ...extraInstrumentations];
}

/**
 * React Native stacktrace parser. Uses getStackFramesFromError for RN-specific formats.
 */
const parseStacktrace: Config['parseStacktrace'] = (err) => ({
  frames: getStackFramesFromError(err),
});

/**
 * Creates a full Faro config from React Native flag-based config.
 *
 * Based on flags, builds instrumentations and transports automatically.
 * Client just enables what they need; makeRNConfig does the rest.
 */
export function makeRNConfig(config: ReactNativeConfig): Config {
  const defaultMetas = [getSdkMeta(), getPageMeta(), getScreenMeta()];
  const customMetas = config.metas ?? [];
  const transports = buildTransports(config);
  const instrumentations = buildInstrumentations(config);

  return {
    app: config.app,
    dedupe: config.dedupe ?? true,
    globalObjectKey: config.globalObjectKey ?? defaultGlobalObjectKey,
    internalLoggerLevel: config.internalLoggerLevel ?? InternalLoggerLevel.ERROR,
    isolate: config.isolate ?? false,
    parseStacktrace: config.parseStacktrace ?? parseStacktrace,
    paused: config.paused ?? false,
    preventGlobalExposure: config.preventGlobalExposure ?? false,
    unpatchedConsole: config.unpatchedConsole ?? defaultUnpatchedConsole,
    batching: {
      enabled: false,
      sendTimeout: 250,
      itemLimit: 50,
    },
    sessionTracking: {
      ...defaultSessionTrackingConfig,
      ...config.sessionTracking,
    } as ReactNativeSessionTrackingConfig,
    metas: [...defaultMetas, ...customMetas],
    instrumentations,
    transports,
    ignoreUrls: config.ignoreUrls ?? [],
    ignoreErrors: config.ignoreErrors,
    beforeSend: config.beforeSend,
    preserveOriginalError: config.preserveOriginalError,
    userActionsInstrumentation: config.userActionsOptions,
    consoleInstrumentation: config.consoleCaptureOptions,
  };
}
