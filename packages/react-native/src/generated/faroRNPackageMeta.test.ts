import packageJson from '../../package.json';

import { FARO_REACT_NATIVE_NPM_NAME, FARO_REACT_NATIVE_NPM_VERSION } from './faroRNPackageMeta';

describe('faroRNPackageMeta', () => {
  it('should match package.json (run yarn build:compile prep script after version bumps)', () => {
    expect(FARO_REACT_NATIVE_NPM_NAME).toBe(packageJson.name);
    expect(FARO_REACT_NATIVE_NPM_VERSION).toBe(packageJson.version);
  });
});
