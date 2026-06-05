import DeviceInfo from 'react-native-device-info';

import { globalObject } from '@grafana/faro-core';

const BUNDLE_ID_SEPARATOR = '@';

/** Metro / webpack preamble bundle id for JS source maps (`__faroBundleId_<appName>`). */
export function getMetroInjectedBundleId(appName: string | undefined): string | undefined {
  if (!appName) {
    return undefined;
  }
  const key = `__faroBundleId_${appName}`;
  const fromGlobal = (globalObject as Record<string, unknown>)[key];
  if (typeof fromGlobal === 'string' && fromGlobal !== '') {
    return fromGlobal;
  }
  return undefined;
}

/**
 * Encodes the Android/iOS build identity used as `meta.app.bundleId` for
 * server-side symbol retrace. Must match the symbols upload bundle id
 * (`{applicationId}@{versionCode}@{versionName}`).
 */
export function formatSymbolsBundleId(applicationId: string, versionCode: string, versionName: string): string {
  return `${applicationId}${BUNDLE_ID_SEPARATOR}${versionCode}${BUNDLE_ID_SEPARATOR}${versionName}`;
}

/**
 * Reads the installed build's identity from `react-native-device-info` and
 * returns the encoded bundle id when all parts are available.
 *
 * Values must match what the symbol uploader (Gradle plugin / faro-cli) sends
 * for the same build so the collector can locate the mapping for retrace.
 */
export async function loadAppSymbolsBundleIdForInit(): Promise<string | undefined> {
  try {
    const applicationId = DeviceInfo.getBundleId();
    const versionName = DeviceInfo.getVersion();
    const versionCodeRaw = DeviceInfo.getBuildNumber();

    if (!applicationId || versionCodeRaw === '' || versionCodeRaw == null || !versionName) {
      return undefined;
    }

    return formatSymbolsBundleId(applicationId, String(versionCodeRaw), versionName);
  } catch {
    return undefined;
  }
}
