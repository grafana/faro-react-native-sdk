import { VERSION } from '@grafana/faro-core';
import type { Meta, MetaItem } from '@grafana/faro-core';

import { FARO_REACT_NATIVE_NPM_VERSION } from '../generated/faroRNPackageMeta';

/**
 * SDK meta for React Native.
 * - `sdk.version`: published `@grafana/faro-react-native` semver for this build.
 * - `sdk.name`: integration id (`faro-web` / `faro-react-native`).
 * - `sdk.integrations`: the `@grafana/faro-core` release this build runs on.
 */
export const getSdkMeta = (): MetaItem<Pick<Meta, 'sdk'>> => {
  return () => ({
    sdk: {
      name: 'faro-react-native',
      version: FARO_REACT_NATIVE_NPM_VERSION,
      integrations: [
        {
          name: '@grafana/faro-core',
          version: VERSION,
        },
      ],
    },
  });
};
