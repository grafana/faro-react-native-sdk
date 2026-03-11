import type { ReactNativeSessionTrackingConfig } from '../../../config/types';

export const STORAGE_KEY = 'com.grafana.faro.session';
export const STORAGE_UPDATE_DELAY = 1 * 1000; // 1 second

const DEFAULT_SESSION_PERSISTENCE_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_SESSION_PERSISTENCE_TIME = DEFAULT_SESSION_PERSISTENCE_MS;

/** React Native session defaults */
export const defaultSessionTrackingConfig: ReactNativeSessionTrackingConfig = {
  enabled: true,
  persistent: false,
  maxSessionPersistenceTime: MAX_SESSION_PERSISTENCE_TIME,
};
