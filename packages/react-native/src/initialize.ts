import { type Faro, initializeFaro as initializeFaroCore } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';
import { loadMobileMetaForInit } from './instrumentations/session/sessionAttributes';
import { loadAppSymbolsBundleIdForInit } from './metas/appBuildIdentity';
import { OfflineTransport } from './transports/offline';

/**
 * Awaits async device/session attribute collection and the build identity used
 * for server-side symbol retrace, then initializes Faro with core
 * `initializeFaro`, and connects offline transports to the instance. On failure during collection, uses
 * `minimalSessionDeviceAttributes` / an empty build identity before init.
 */
export async function initializeFaro(config: ReactNativeConfig): Promise<Faro> {
  const [preloadedMobileMeta, appSymbolsBundleId] = await Promise.all([
    loadMobileMetaForInit(),
    loadAppSymbolsBundleIdForInit(),
  ]);
  const fullConfig = makeRNConfig(config, preloadedMobileMeta, appSymbolsBundleId);
  const faro = initializeFaroCore(fullConfig);
  // Offline transports replay their cache through the other transports of this instance.
  for (const transport of faro.transports.transports) {
    if (transport instanceof OfflineTransport) {
      transport.bindTransports(faro.transports);
    }
  }
  return faro;
}
