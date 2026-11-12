import { type Faro, initializeFaro as initializeFaroCore, isInternalFaroOnGlobalObject } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';
import { loadMobileMetaForInit } from './instrumentations/session/sessionAttributes';
import { loadAppSymbolsBundleIdForInit } from './metas/appBuildIdentity';
import { resolveDynamicDeviceStateGroups, startDynamicDeviceState } from './metas/dynamicDeviceState';

/**
 * Awaits async device/session attribute collection and the build identity used
 * for server-side symbol retrace, then initializes Faro with core
 * `initializeFaro`. On failure during collection, uses
 * `minimalSessionDeviceAttributes` / an empty build identity before init.
 */
export async function initializeFaro(config: ReactNativeConfig): Promise<Faro> {
  // Starts first so the native caches fill while the async collection runs. Core rejects a second
  // call, so it must not replace the groups of the instance that is already running.
  const dynamicDeviceStateGroups = resolveDynamicDeviceStateGroups(config.dynamicDeviceState);
  if (!isInternalFaroOnGlobalObject() || config.isolate) {
    startDynamicDeviceState(dynamicDeviceStateGroups);
  }

  const [preloadedMobileMeta, appSymbolsBundleId] = await Promise.all([
    loadMobileMetaForInit(dynamicDeviceStateGroups),
    loadAppSymbolsBundleIdForInit(),
  ]);
  const fullConfig = makeRNConfig(config, preloadedMobileMeta, appSymbolsBundleId);
  return initializeFaroCore(fullConfig);
}
