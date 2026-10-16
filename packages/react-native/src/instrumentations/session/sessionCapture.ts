import type { TransportItem, Transports } from '@grafana/faro-core';

// Session bookkeeping runs when an item is captured, before faro-core queues it
// for batching, because beforeSend hooks only run when the queue is sent. Each
// transports object is wrapped once; the wrapper routes items to the handler of
// the instrumentation that currently owns it, so a superseded instance yields.
export type SessionCaptureHandler = (item: TransportItem) => TransportItem | null;

const activeSessionCaptureHandlers = new WeakMap<Transports, SessionCaptureHandler>();
const sessionCaptureWrappers = new WeakMap<
  Transports,
  { wrapped: Transports['execute']; original: Transports['execute'] }
>();

/**
 * Applies session attribution and sampling to an item, as if it was captured
 * now. Code that sends without `transports.execute`, such as recovered crash
 * replay, must call this before the beforeSend hooks. Returns `null` when the
 * item belongs to an unsampled session.
 */
export function captureSessionItem(transports: Transports, item: TransportItem): TransportItem | null {
  const activeHandler = activeSessionCaptureHandlers.get(transports);
  return activeHandler == null ? item : activeHandler(item);
}

export function isActiveSessionCaptureHandler(transports: Transports, handler: SessionCaptureHandler): boolean {
  return activeSessionCaptureHandlers.get(transports) === handler;
}

export function installSessionCaptureHandler(transports: Transports, handler: SessionCaptureHandler): void {
  if (!sessionCaptureWrappers.has(transports)) {
    const original = transports.execute;
    const wrapped: Transports['execute'] = (item) => {
      // Paused transports drop items, so they do not count as session activity.
      const capturedItem = transports.isPaused() ? item : captureSessionItem(transports, item);
      if (capturedItem != null) {
        original(capturedItem);
      }
    };
    transports.execute = wrapped;
    sessionCaptureWrappers.set(transports, { wrapped, original });
  }

  activeSessionCaptureHandlers.set(transports, handler);
}

export function uninstallSessionCaptureHandler(transports: Transports, handler: SessionCaptureHandler): void {
  if (!isActiveSessionCaptureHandler(transports, handler)) {
    return;
  }

  activeSessionCaptureHandlers.delete(transports);
  const wrapper = sessionCaptureWrappers.get(transports);
  // If something else wrapped `execute` since, keep ours as a pass-through.
  if (wrapper != null && transports.execute === wrapper.wrapped) {
    transports.execute = wrapper.original;
    sessionCaptureWrappers.delete(transports);
  }
}
