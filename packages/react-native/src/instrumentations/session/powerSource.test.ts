import { NativeModules, Platform } from 'react-native';

import { isConnectedToPower } from './powerSource';

describe('isConnectedToPower', () => {
  const originalNativeModule = NativeModules.FaroReactNativeModule;
  const originalOS = Platform.OS;

  afterEach(() => {
    NativeModules.FaroReactNativeModule = originalNativeModule;
    (Platform as any).OS = originalOS;
  });

  it.each([true, false])('should return the native Android plug state %p', async (connected) => {
    (Platform as any).OS = 'android';
    NativeModules.FaroReactNativeModule = { isConnectedToPower: jest.fn().mockResolvedValue(connected) };

    await expect(isConnectedToPower()).resolves.toBe(connected);
  });

  it('should not call the native module outside Android', async () => {
    (Platform as any).OS = 'ios';
    const nativeIsConnectedToPower = jest.fn().mockResolvedValue(true);
    NativeModules.FaroReactNativeModule = { isConnectedToPower: nativeIsConnectedToPower };

    await expect(isConnectedToPower()).resolves.toBeUndefined();
    expect(nativeIsConnectedToPower).not.toHaveBeenCalled();
  });

  it.each([
    ['the native module is missing', undefined],
    ['the method is missing', {}],
    ['the plug state is unknown', { isConnectedToPower: jest.fn().mockResolvedValue(null) }],
    ['the native call rejects', { isConnectedToPower: jest.fn().mockRejectedValue(new Error('unavailable')) }],
  ])('should return undefined when %s', async (_case, nativeModule) => {
    (Platform as any).OS = 'android';
    NativeModules.FaroReactNativeModule = nativeModule;

    await expect(isConnectedToPower()).resolves.toBeUndefined();
  });
});
