import { AppState, type AppStateStatus } from 'react-native';

import { faro } from '@grafana/faro-core';

import { SessionActivityKind } from '../sessionActivity';

import { getSessionMetaUpdateHandler, getUserSessionUpdater } from './sessionManagerUtils';
import type { FaroUserSession } from './types';

export class VolatileSessionsManager {
  private static volatileStorage: FaroUserSession | null = null;
  private updateUserSession: ReturnType<typeof getUserSessionUpdater>;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private wasBackgrounded = AppState.currentState === 'background';
  private metaUnsubscribe: (() => void) | null = null;

  constructor() {
    this.updateUserSession = getUserSessionUpdater({
      fetchUserSession: VolatileSessionsManager.fetchUserSession,
      storeUserSession: VolatileSessionsManager.storeUserSession,
    });

    this.init();
  }

  static removeUserSession(): void {
    VolatileSessionsManager.volatileStorage = null;
  }

  static storeUserSession(session: FaroUserSession): void {
    VolatileSessionsManager.volatileStorage = session;
  }

  static fetchUserSession(): FaroUserSession | null {
    return VolatileSessionsManager.volatileStorage;
  }

  checkSession(activity: SessionActivityKind, currentSession?: FaroUserSession | null): FaroUserSession {
    return this.updateUserSession(activity, currentSession);
  }

  private handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (nextAppState === 'background') {
      this.wasBackgrounded = true;
      return;
    }

    if (nextAppState === 'active' && this.wasBackgrounded) {
      this.wasBackgrounded = false;
      this.checkSession(SessionActivityKind.Meaningful);
    }
  };

  private init(): void {
    // Listen to app state changes (equivalent to visibilitychange in web)
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);

    // Users can call the setSession() method, so we need to sync this with the in-memory session
    const unsubscribe = faro.metas.addListener(
      getSessionMetaUpdateHandler({
        fetchUserSession: VolatileSessionsManager.fetchUserSession,
        storeUserSession: VolatileSessionsManager.storeUserSession,
      })
    );
    this.metaUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
  }

  /**
   * Clean up listeners when the instrumentation is unpatched
   */
  unpatch(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    if (this.metaUnsubscribe) {
      this.metaUnsubscribe();
      this.metaUnsubscribe = null;
    }
  }
}
