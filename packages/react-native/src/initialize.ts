import { type Faro, initializeFaro as initializeFaroCore } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';
import { loadSessionDeviceAttributesForInit } from './instrumentations/session/sessionAttributes';
import { loadAppSymbolsBundleIdForInit } from './metas/appBuildIdentity';

/**
 * Awaits async device/session attribute collection and the build identity used
 * for server-side symbol retrace, then initializes Faro with core
 * `initializeFaro`. On failure during collection, uses
 * `minimalSessionDeviceAttributes` / an empty build identity before init.
 */
export async function initializeFaro(config: ReactNativeConfig): Promise<Faro> {
  const [preloadedSessionDeviceAttributes, appSymbolsBundleId] = await Promise.all([
    loadSessionDeviceAttributesForInit(),
    loadAppSymbolsBundleIdForInit(),
  ]);
  const fullConfig = makeRNConfig(config, preloadedSessionDeviceAttributes, appSymbolsBundleId);
  return initializeFaroCore(fullConfig);
}
