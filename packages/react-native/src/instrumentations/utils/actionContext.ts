import {
  type EventEvent,
  faro,
  type PushEventOptions,
  type UserActionInternalInterface,
  UserActionState,
} from '@grafana/faro-core';

/**
 * PushEvent options with action context for linking events to user actions.
 * When an active user action exists, adds payload.action so events appear in
 * Grafana's user action table (e.g. HTTP Errors column).
 */
export function getPushEventOptionsWithActionContext(): PushEventOptions | undefined {
  try {
    const currentAction = faro.api?.getActiveUserAction?.();
    const state = (currentAction as unknown as UserActionInternalInterface)?.getState?.();
    if (currentAction && (state === UserActionState.Started || state === UserActionState.Halted)) {
      const name = currentAction.name;
      const parentId = currentAction.parentId;
      return {
        customPayloadTransformer: (payload: EventEvent): EventEvent => {
          payload.action = { name, parentId };
          return payload;
        },
      };
    }
  } catch (_) {
    // Silently fail - don't log to avoid instrumentation loops
  }
  return undefined;
}
