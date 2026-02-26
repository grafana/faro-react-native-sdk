import type { ReactNativeSessionTrackingConfig } from '../../../config/types';

export const STORAGE_KEY = 'com.grafana.faro.session';
export const SESSION_EXPIRATION_TIME = 4 * 60 * 60 * 1000; // 4 hours
export const SESSION_INACTIVITY_TIME = 15 * 60 * 1000; // 15 minutes
export const STORAGE_UPDATE_DELAY = 1 * 1000; // 1 second

export const MAX_SESSION_PERSISTENCE_TIME = SESSION_INACTIVITY_TIME;

/** React Native session defaults; includes RN-specific inactivityTimeout and sessionExpirationTime */
export const defaultSessionTrackingConfig: ReactNativeSessionTrackingConfig = {
  enabled: true,
  persistent: false,
  maxSessionPersistenceTime: MAX_SESSION_PERSISTENCE_TIME,
  inactivityTimeout: SESSION_INACTIVITY_TIME,
  sessionExpirationTime: SESSION_EXPIRATION_TIME,
};
