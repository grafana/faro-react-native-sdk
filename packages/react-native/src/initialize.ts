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
  // For async instrumentations like SessionInstrumentation, this returns promises
  const faro = initializeFaroCore(fullConfig);
  
  // Wait longer for async initialization (session storage, etc.) to complete
  // SessionInstrumentation.initialize() is async and sets session in metas
  await new Promise(resolve => setTimeout(resolve, 200));
  
  return faro;
}
