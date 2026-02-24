import { AppState, type AppStateStatus } from 'react-native';

import { BaseInstrumentation, dateNow, VERSION } from '@grafana/faro-core';

// Event name aligned with Faro Flutter SDK (app_lifecycle_changed)
export const EVENT_APP_STATE_CHANGED = 'app_lifecycle_changed';

/**
 * Maps React Native AppStateStatus to Flutter AppLifecycleState names for cross-SDK consistency.
 * RN active=resumed, background=paused, inactive=inactive, unknown/extension=detached
 */
function mapToFlutterLifecycleState(rnState: AppStateStatus | undefined): string {
  if (!rnState) return 'detached';
  switch (rnState) {
    case 'active':
      return 'resumed';
    case 'background':
      return 'paused';
    case 'inactive':
      return 'inactive';
    case 'unknown':
    case 'extension':
    default:
      return 'detached';
  }
}

/**
 * AppState instrumentation for React Native
 * Tracks app foreground/background/inactive state changes
 *
 * Uses event name and state names aligned with Faro Flutter SDK (app_lifecycle_changed, resumed/paused/inactive/detached).
 *
 * React Native AppState → Flutter AppLifecycleState mapping:
 * - 'active' → 'resumed'
 * - 'background' → 'paused'
 * - 'inactive' → 'inactive'
 * - 'unknown'/'extension' → 'detached'
 */
export class AppStateInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-appstate';
  readonly version = VERSION;

  private currentState: AppStateStatus | undefined;
  private stateStartTime: number | undefined;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;

  initialize(): void {
    // Get initial app state
    this.currentState = AppState.currentState;
    this.stateStartTime = dateNow();

    this.logInfo('AppState instrumentation initialized', {
      initialState: this.currentState,
    });

    // Subscribe to app state changes
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
  }

  /**
   * Handles app state changes and emits app_lifecycle_changed events.
   * State names aligned with Faro Flutter SDK (resumed/paused/inactive/detached).
   * Includes duration and timestamp for time-in-state analysis.
   */
  private handleAppStateChange = (nextAppState: AppStateStatus): void => {
    const previousState = this.currentState;
    const now = dateNow();
    const duration = this.stateStartTime ? now - this.stateStartTime : 0;

    // Update state tracking
    this.currentState = nextAppState;
    this.stateStartTime = now;

    // Log the state change (internal debug keeps RN state names)
    this.logDebug('App state changed', {
      from: previousState,
      to: nextAppState,
      duration,
    });

    // Emit app lifecycle change event (Flutter-aligned state names + RN duration/timestamp)
    const fromState = previousState !== undefined ? mapToFlutterLifecycleState(previousState) : '';
    const toState = mapToFlutterLifecycleState(nextAppState);
    this.api.pushEvent(
      EVENT_APP_STATE_CHANGED,
      {
        fromState,
        toState,
        duration: duration.toString(),
        timestamp: now.toString(),
      },
      undefined,
      { skipDedupe: true }
    );

    // Additional logging for specific transitions
    if (nextAppState === 'background') {
      this.logInfo('App moved to background', { fromState: previousState, duration });
    } else if (nextAppState === 'active' && previousState === 'background') {
      this.logInfo('App returned to foreground', { duration });
    } else if (nextAppState === 'inactive') {
      this.logDebug('App became inactive', { fromState: previousState });
    }
  };

  /**
   * Get the current app state
   */
  getCurrentState(): AppStateStatus | undefined {
    return this.currentState;
  }

  /**
   * Get the duration the app has been in the current state (in milliseconds)
   */
  getCurrentStateDuration(): number {
    if (!this.stateStartTime) {
      return 0;
    }
    return dateNow() - this.stateStartTime;
  }

  /**
   * Check if app is currently in the foreground (active state)
   */
  isActive(): boolean {
    return this.currentState === 'active';
  }

  /**
   * Check if app is currently in the background
   */
  isBackground(): boolean {
    return this.currentState === 'background';
  }

  /**
   * Cleanup: Remove app state listener
   */
  unpatch(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = undefined;
      this.logInfo('AppState instrumentation unpatched');
    }
  }
}
