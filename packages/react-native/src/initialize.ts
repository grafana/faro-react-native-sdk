import { type Faro, initializeFaro as initializeFaroCore } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';
import { loadMobileMetaForInit } from './instrumentations/session/sessionAttributes';

/**
 * Awaits async device/session attribute collection, then initializes Faro with core `initializeFaro`.
 * On failure during collection, uses `minimalSessionDeviceAttributes` before init.
 */
export async function initializeFaro(config: ReactNativeConfig): Promise<Faro> {
  const preloadedMobileMeta = await loadMobileMetaForInit();
  const fullConfig = makeRNConfig(config, preloadedMobileMeta);
  return initializeFaroCore(fullConfig);
}
