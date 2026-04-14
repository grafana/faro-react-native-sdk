import { VERSION } from '@grafana/faro-core';

import packageJson from '../../package.json';
import { FARO_REACT_NATIVE_NPM_NAME, FARO_REACT_NATIVE_NPM_VERSION } from '../generated/faroRNPackageMeta';

import { getSdkMeta } from './sdk';

describe('getSdkMeta', () => {
  it('should set core sdk line and npm integration from generated meta', () => {
    const meta = getSdkMeta()();
    expect(meta.sdk?.name).toBe('faro-react-native');
    expect(meta.sdk?.version).toBe(VERSION);
    expect(meta.sdk?.integrations).toEqual([
      { name: FARO_REACT_NATIVE_NPM_NAME, version: FARO_REACT_NATIVE_NPM_VERSION },
    ]);
    expect(FARO_REACT_NATIVE_NPM_NAME).toBe(packageJson.name);
    expect(FARO_REACT_NATIVE_NPM_VERSION).toBe(packageJson.version);
  });
});
