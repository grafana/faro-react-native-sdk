import AsyncStorage from '@react-native-async-storage/async-storage';

const INSTALLATION_ID_STORAGE_KEY = '@grafana/faro-react-native/installation_id';

function createRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObject = globalThis.crypto;

  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  return bytes;
}

function generateInstallationId(): string {
  const bytes = createRandomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function getInstallationId(): Promise<string | undefined> {
  try {
    const storedInstallationId = await AsyncStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (storedInstallationId) {
      return storedInstallationId;
    }

    const installationId = generateInstallationId();
    await AsyncStorage.setItem(INSTALLATION_ID_STORAGE_KEY, installationId);
    return installationId;
  } catch (_error) {
    return undefined;
  }
}
