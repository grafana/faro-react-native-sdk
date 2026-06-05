import { defaultGlobalObjectKey, defaultUnpatchedConsole } from '@grafana/faro-core';
import type { Config, MetaApp, MetaItem } from '@grafana/faro-core';

import { getMetroInjectedBundleId } from '../metas/appBuildIdentity';

import { getStackFramesFromError } from '../instrumentations/errors/stackTraceParser';
import type { SessionAttributes } from '../instrumentations/session/sessionAttributes';
import { defaultSessionTrackingConfig } from '../instrumentations/session/sessionManager/sessionConstants';
import { InternalLoggerLevel, LogLevel } from '../internalLogger';
import { getPageMeta } from '../metas/page';
import { getScreenMeta } from '../metas/screen';
import { getSdkMeta } from '../metas/sdk';
import { ConsoleTransport } from '../transports/console';
import { FetchTransport } from '../transports/fetch';
import { OfflineTransport } from '../transports/offline';

import { getRNInstrumentations } from './getRNInstrumentations';
import type { ReactNativeConfig, ReactNativeFullConfig } from './types';

const DEFAULT_OFFLINE_CACHE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Encoded Android/iOS symbols bundle id (`applicationId@versionCode@versionName`) is
 * only applied when no JS source-map bundle id is already in play. Metro / env /
 * `config.app.bundleId` must keep working unchanged (see registerInitialMetas).
 */
function symbolsBundleIdMeta(
  configApp: MetaApp | undefined,
  appName: string | undefined,
  appSymbolsBundleId?: string
): MetaItem[] {
  if (!appSymbolsBundleId) {
    return [];
  }
  if (configApp?.bundleId) {
    return [];
  }
  if (getMetroInjectedBundleId(appName)) {
    return [];
  }
  return [{ app: { bundleId: appSymbolsBundleId } }];
}

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
function createParseStacktrace(releaseBundleFilename: string | undefined): Config['parseStacktrace'] {
  return (err) => ({
    frames: getStackFramesFromError(err, { releaseBundleFilename }),
  });
}

/**
 * Creates a full Faro config from React Native flag-based config.
 *
 * Based on flags, builds instrumentations and transports automatically.
 * Client just enables what they need; makeRNConfig does the rest.
 *
 * @param preloadedSessionDeviceAttributes Device/session fields for session meta (passed from async `initializeFaro`).
 * @param appSymbolsBundleId Encoded `meta.app.bundleId` for server-side symbol retrace.
 */
export function makeRNConfig(
  config: ReactNativeConfig,
  preloadedSessionDeviceAttributes?: SessionAttributes,
  appSymbolsBundleId?: string
): ReactNativeFullConfig {
  const defaultMetas = [getSdkMeta(), getPageMeta(), getScreenMeta()];
  const customMetas = config.metas ?? [];
  const transports = buildTransports(config);
  const instrumentations = buildInstrumentations(config);

  const releaseBundleFilename = config.releaseBundleFilename;
  return {
    app: config.app,
    ...(preloadedSessionDeviceAttributes != null && {
      preloadedSessionDeviceAttributes,
    }),
    dedupe: config.dedupe ?? true,
    globalObjectKey: config.globalObjectKey ?? defaultGlobalObjectKey,
    internalLoggerLevel: config.internalLoggerLevel ?? InternalLoggerLevel.ERROR,
    isolate: config.isolate ?? false,
    parseStacktrace: config.parseStacktrace ?? createParseStacktrace(releaseBundleFilename),
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
    },
    metas: [
      ...defaultMetas,
      ...customMetas,
      ...symbolsBundleIdMeta(config.app, config.app?.name, appSymbolsBundleId),
    ],
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
