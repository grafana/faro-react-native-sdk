import { faro } from '@grafana/faro-core';

type DirectSessionActivityHandler = () => void;

let directSessionActivityHandler: DirectSessionActivityHandler | undefined;

/** Registers the active session manager as the direct-activity consumer. */
export function registerDirectSessionActivityHandler(handler: DirectSessionActivityHandler): () => void {
  directSessionActivityHandler = handler;

  return () => {
    if (directSessionActivityHandler === handler) {
      directSessionActivityHandler = undefined;
    }
  };
}

/**
 * Refreshes session inactivity without emitting telemetry.
 *
 * This is a no-op until session tracking has initialized. Use it for direct
 * interactions that do not pass through `FaroSessionActivityBoundary`.
 */
export function notifySessionActivity(): void {
  try {
    directSessionActivityHandler?.();
  } catch (error) {
    // Session tracking must never interrupt the interaction being observed.
    faro.unpatchedConsole?.warn?.('Failed to record session activity:', error);
  }
}
