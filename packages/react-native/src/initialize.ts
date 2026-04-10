import { type Faro, initializeFaro as initializeFaroCore } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';

/**
 * Initialize Faro SDK (returns immediately, session may not be available yet)
 * 
 * @deprecated Use `initializeFaroAsync()` instead to ensure session is initialized before sending telemetry.
 * This synchronous version may result in missing session metadata in early telemetry events.
 */
export function initializeFaro(config: ReactNativeConfig): Faro {
  const fullConfig = makeRNConfig(config);
  return initializeFaroCore(fullConfig);
}

/**
 * Initialize Faro SDK and wait for session to be ready (recommended)
 * 
 * This async version ensures the session is fully initialized before returning,
 * preventing race conditions where early telemetry events lack session metadata.
 * 
 * @example
 * ```typescript
 * const faro = await initializeFaroAsync({
 *   url: 'https://...',
 *   app: { name: 'my-app' }
 * });
 * ```
 */
export async function initializeFaroAsync(config: ReactNativeConfig): Promise<Faro> {
  const fullConfig = makeRNConfig(config);
  
  // initializeFaroCore calls initialize() on all instrumentations
  // Note: faro-core doesn't await async initialize() methods, so we need to wait manually
  const faro = initializeFaroCore(fullConfig);
  
  // Wait for session to be initialized (with timeout fallback)
  // SessionInstrumentation.initialize() is async and sets session in metas
  const maxWaitMs = 1000;
  const checkIntervalMs = 50;
  let waitedMs = 0;
  
  while (!faro.metas.value.session && waitedMs < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    waitedMs += checkIntervalMs;
  }
  
  return faro;
}
