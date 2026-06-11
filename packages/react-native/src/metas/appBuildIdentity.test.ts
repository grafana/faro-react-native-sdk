import DeviceInfo from 'react-native-device-info';

import { formatSymbolsBundleId, loadAppSymbolsBundleIdForInit } from './appBuildIdentity';

describe('formatSymbolsBundleId', () => {
  it('joins applicationId, versionCode and versionName with @', () => {
    expect(formatSymbolsBundleId('com.example.myapp', '42', '1.0.0')).toBe('com.example.myapp@42@1.0.0');
  });
});

describe('loadAppSymbolsBundleIdForInit', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('maps DeviceInfo build info to an encoded bundle id', async () => {
    const bundleId = await loadAppSymbolsBundleIdForInit();

    expect(bundleId).toBe('com.example.myapp@42@1.0.0');
  });

  it('coerces a numeric build number to a string in the bundle id', async () => {
    (DeviceInfo.getBuildNumber as jest.Mock).mockReturnValueOnce(7);

    const bundleId = await loadAppSymbolsBundleIdForInit();

    expect(bundleId).toBe('com.example.myapp@7@1.0.0');
  });

  it('returns undefined when required fields are missing', async () => {
    (DeviceInfo.getBundleId as jest.Mock).mockReturnValueOnce('');
    (DeviceInfo.getBuildNumber as jest.Mock).mockReturnValueOnce('');

    const bundleId = await loadAppSymbolsBundleIdForInit();

    expect(bundleId).toBeUndefined();
  });

  it('returns undefined when DeviceInfo throws', async () => {
    (DeviceInfo.getBundleId as jest.Mock).mockImplementationOnce(() => {
      throw new Error('not available');
    });

    const bundleId = await loadAppSymbolsBundleIdForInit();

    expect(bundleId).toBeUndefined();
  });
});
