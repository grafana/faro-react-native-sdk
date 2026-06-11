import { defaultGlobalObjectKey, defaultUnpatchedConsole } from '@grafana/faro-core';
import type { Config, MetaApp, MetaItem } from '@grafana/faro-core';

import { getStackFramesFromError } from '../instrumentations/errors/stackTraceParser';
import type { PreloadedMobileMeta } from '../instrumentations/session/sessionAttributes';
import { defaultSessionTrackingConfig } from '../instrumentations/session/sessionManager/sessionConstants';
import { InternalLoggerLevel, LogLevel } from '../internalLogger';
import { getMetroInjectedBundleId } from '../metas/appBuildIdentity';
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
 * Resolves `meta.app.bundleId` when it is not already supplied by faro-core from
 * the Metro preamble (`registerInitialMetas` / `__faroBundleId_<appName>`).
 *
 * Priority: explicit `config.app.bundleId` → Metro preamble (core) → DeviceInfo
 * fallback (`applicationId@versionCode@versionName`, same shape Gradle/Metro use).
 */
function symbolsBundleIdMeta(
  configApp: MetaApp | undefined,
  appName: string | undefined,
  appSymbolsBundleId?: string
): MetaItem[] {
  if (configApp?.bundleId) {
    return [{ app: { bundleId: configApp.bundleId } }];
  }
  if (getMetroInjectedBundleId(appName)) {
    return [];
  }
  if (!appSymbolsBundleId) {
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
 * @param preloadedMobileMeta Device/session fields and structured mobile meta (passed from async `initializeFaro`).
 * @param appSymbolsBundleId Encoded `meta.app.bundleId` for server-side symbol retrace.
 */
export function makeRNConfig(
  config: ReactNativeConfig,
  preloadedMobileMeta?: PreloadedMobileMeta,
  appSymbolsBundleId?: string
): ReactNativeFullConfig {
  const { app: preloadedAppMeta, ...structuredMobileMeta } = preloadedMobileMeta?.meta ?? {};
  const mobileMetas = Object.keys(structuredMobileMeta).length > 0 ? [structuredMobileMeta] : [];
  const defaultMetas = [getSdkMeta(), getPageMeta(), getScreenMeta(), ...mobileMetas];
  const customMetas = config.metas ?? [];
  const transports = buildTransports(config);
  const instrumentations = buildInstrumentations(config);
  const installationId = config.app.installationId ?? preloadedAppMeta?.installationId;

  const releaseBundleFilename = config.releaseBundleFilename;
  return {
    app: {
      ...config.app,
      ...(installationId && { installationId }),
    },
    ...(preloadedMobileMeta != null && {
      preloadedMobileMeta: preloadedMobileMeta.meta,
      preloadedSessionDeviceAttributes: preloadedMobileMeta.sessionAttributes,
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
    metas: [...defaultMetas, ...customMetas, ...symbolsBundleIdMeta(config.app, config.app?.name, appSymbolsBundleId)],
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
