import { VERSION } from '@grafana/faro-core';

import packageJson from '../../package.json';
import { FARO_REACT_NATIVE_NPM_NAME, FARO_REACT_NATIVE_NPM_VERSION } from '../generated/faroRNPackageMeta';

import { getSdkMeta } from './sdk';

describe('getSdkMeta', () => {
  it('should report the React Native package version and list faro-core as an integration', () => {
    const meta = getSdkMeta()();
    expect(meta.sdk?.name).toBe('faro-react-native');
    expect(meta.sdk?.version).toBe(packageJson.version);
    expect(meta.sdk?.integrations).toEqual([{ name: '@grafana/faro-core', version: VERSION }]);
    expect(FARO_REACT_NATIVE_NPM_NAME).toBe(packageJson.name);
    expect(FARO_REACT_NATIVE_NPM_VERSION).toBe(packageJson.version);
  });
});
