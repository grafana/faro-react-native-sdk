import type { Config } from '@grafana/faro-core';

import { getScreenMeta } from '../metas/screen';
import { getSdkMeta } from '../metas/sdk';

import type { ReactNativeConfig } from './types';

/**
 * Creates a full Faro config from React Native specific config
 */
export function makeRNConfig(config: ReactNativeConfig): Config {
  const { metas = [], ...rest } = config;

  // Default metas for React Native
  // Note: We do NOT include device meta (browser field) or page meta to match Flutter SDK.
  // Device info is sent via session attributes with device_* prefixes.
  // Screen tracking is handled via view meta.
  const defaultMetas = [getSdkMeta(), getScreenMeta()];

  return {
    ...rest,
    // Disable core batching since it uses browser APIs (document, window)
    // The FetchTransport handles its own batching via promiseBuffer
    batching: {
      enabled: false,
      sendTimeout: 250,
      itemLimit: 50,
    },
    // Enable session tracking by default
    sessionTracking: {
      enabled: true,
      ...config.sessionTracking,
    },
    metas: [...defaultMetas, ...metas],
  };
}
