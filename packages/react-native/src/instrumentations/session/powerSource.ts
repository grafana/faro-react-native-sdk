import { NativeModules, Platform } from 'react-native';

interface PowerSourceNativeModule {
  isConnectedToPower?: () => Promise<unknown>;
}

/**
 * Whether an Android device is connected to power, from the battery broadcast's plug type.
 *
 * `react-native-device-info` reports a plugged-in device whose charging is paused (battery
 * protection, charge limits, heat) as `unknown`, so Android reads the plug type natively.
 * Returns `undefined` on other platforms or when the native module cannot tell.
 */
export async function isConnectedToPower(): Promise<boolean | undefined> {
  if (Platform.OS !== 'android') {
    return undefined;
  }

  const nativeModule = NativeModules['FaroReactNativeModule'] as PowerSourceNativeModule | undefined;
  if (typeof nativeModule?.isConnectedToPower !== 'function') {
    return undefined;
  }

  try {
    const connected = await nativeModule.isConnectedToPower();
    return typeof connected === 'boolean' ? connected : undefined;
  } catch {
    return undefined;
  }
}
