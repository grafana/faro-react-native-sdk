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
 *
 * Like faro-core, resolves to `undefined` when Faro is already initialized and
 * `isolate` is not set, for example after a Fast Refresh.
 */
export async function initializeFaro(config: ReactNativeConfig): Promise<Faro> {
  const [preloadedMobileMeta, appSymbolsBundleId] = await Promise.all([
    loadMobileMetaForInit(),
    loadAppSymbolsBundleIdForInit(),
  ]);
  const fullConfig = makeRNConfig(config, preloadedMobileMeta, appSymbolsBundleId);
  // Typed as always returning Faro, but undefined when Faro is already registered.
  const faro = initializeFaroCore(fullConfig) as Faro | undefined;
  if (!faro) {
    // Not registered: release the offline transports of this config that no Faro instance uses.
    for (const transport of fullConfig.transports) {
      if (transport instanceof OfflineTransport && !transport.isBound()) {
        transport.dispose();
      }
    }
  }
  const transports = faro?.transports;
  // Offline transports replay their cache through the other transports of this instance.
  for (const transport of transports?.transports ?? []) {
    if (transport instanceof OfflineTransport && transports) {
      transport.bindTransports(transports);
    }
  }
  return faro as Faro;
}
