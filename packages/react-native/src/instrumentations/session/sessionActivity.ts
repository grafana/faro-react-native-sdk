import { EVENT_VIEW_CHANGED, TransportItemType } from '@grafana/faro-core';
import type { TransportItem } from '@grafana/faro-core';

import { EVENT_NAVIGATION } from '../../navigation/utils';
import { EVENT_APP_STATE_CHANGED } from '../appState';

export enum SessionActivityKind {
  Meaningful = 'meaningful',
  Passive = 'passive',
}

type ActivityEventPayload = {
  action?: unknown;
  attributes?: Record<string, string>;
  name?: string;
};

/** Classifies how a transport item affects the session inactivity window. */
export function classifySessionActivity(item: TransportItem): SessionActivityKind {
  const payload = item.payload as ActivityEventPayload;

  if (payload.action != null) {
    return SessionActivityKind.Meaningful;
  }

  if (item.type !== TransportItemType.EVENT) {
    return SessionActivityKind.Passive;
  }

  if (payload.name === EVENT_VIEW_CHANGED || payload.name === EVENT_NAVIGATION) {
    return SessionActivityKind.Meaningful;
  }

  if (payload.name === EVENT_APP_STATE_CHANGED && payload.attributes?.['toState'] === 'active') {
    return SessionActivityKind.Meaningful;
  }

  return SessionActivityKind.Passive;
}

type CrashPayload = {
  fatal?: unknown;
  type?: unknown;
};

/** Recovered crashes keep the session captured by the previous process. */
export function isRecoveredCrashItem(item: TransportItem, currentSessionId: string | undefined): boolean {
  if (item.type !== TransportItemType.EXCEPTION || item.meta.session?.id == null) {
    return false;
  }

  const payload = item.payload as CrashPayload;
  return payload.type === 'crash' && payload.fatal === true && item.meta.session.id !== currentSessionId;
}
