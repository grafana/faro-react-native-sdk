import { EVENT_VIEW_CHANGED, TransportItemType } from '@grafana/faro-core';
import type { TransportItem } from '@grafana/faro-core';

import { EVENT_NAVIGATION } from '../../navigation/utils';
import { EVENT_APP_STATE_CHANGED } from '../appState';

import { classifySessionActivity, isRecoveredCrashItem, SessionActivityKind } from './sessionActivity';

function item(type: TransportItemType, payload: Record<string, unknown>, sessionId = 'current'): TransportItem {
  return {
    type,
    payload: payload as TransportItem['payload'],
    meta: { session: { id: sessionId } },
  };
}

describe('session activity classification', () => {
  it.each([
    ['view changes', item(TransportItemType.EVENT, { name: EVENT_VIEW_CHANGED })],
    ['navigation', item(TransportItemType.EVENT, { name: EVENT_NAVIGATION })],
    [
      'foreground returns',
      item(TransportItemType.EVENT, {
        name: EVENT_APP_STATE_CHANGED,
        attributes: { fromState: 'background', toState: 'active' },
      }),
    ],
    ['tracked actions', item(TransportItemType.EXCEPTION, { action: { name: 'checkout' } })],
  ])('treats %s as meaningful', (_name, transportItem) => {
    expect(classifySessionActivity(transportItem)).toBe(SessionActivityKind.Meaningful);
  });

  it.each([
    ['generic events', item(TransportItemType.EVENT, { name: 'poll_complete' })],
    ['unmarked HTTP events', item(TransportItemType.EVENT, { name: 'faro.tracing.fetch' })],
    [
      'background lifecycle events',
      item(TransportItemType.EVENT, {
        name: EVENT_APP_STATE_CHANGED,
        attributes: { toState: 'background' },
      }),
    ],
    [
      'returns from an inactive overlay',
      item(TransportItemType.EVENT, {
        name: EVENT_APP_STATE_CHANGED,
        attributes: { fromState: 'inactive', toState: 'active' },
      }),
    ],
    ['logs', item(TransportItemType.LOG, { message: 'heartbeat' })],
    ['errors', item(TransportItemType.EXCEPTION, { type: 'error', value: 'failure' })],
    ['measurements', item(TransportItemType.MEASUREMENT, { type: 'cpu', values: { usage: 1 } })],
    ['traces', item(TransportItemType.TRACE, { trace_id: 'trace-id' })],
  ])('treats %s as passive', (_name, transportItem) => {
    expect(classifySessionActivity(transportItem)).toBe(SessionActivityKind.Passive);
  });

  it('recognizes a fatal crash recovered from a previous session', () => {
    const recoveredCrash = item(
      TransportItemType.EXCEPTION,
      { fatal: true, type: 'crash', value: 'native crash' },
      'previous'
    );

    expect(isRecoveredCrashItem(recoveredCrash, 'current')).toBe(true);
    expect(isRecoveredCrashItem(recoveredCrash, 'previous')).toBe(false);
  });
});
