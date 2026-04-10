import { type Faro, initializeFaro as initializeFaroCore } from '@grafana/faro-core';

import { makeRNConfig } from './config/makeRNConfig';
import type { ReactNativeConfig } from './config/types';

/**
 * Synchronous initialization (legacy)
 * Note: Session may not be immediately available when this returns
 */
export function initializeFaro(config: ReactNativeConfig): Faro {
  const fullConfig = makeRNConfig(config);
  return initializeFaroCore(fullConfig);
}

/**
 * Async initialization that waits for all instrumentations to be ready
 * Use this when you need to ensure session is initialized before app becomes interactive
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
