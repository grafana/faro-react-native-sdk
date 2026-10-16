import { EVENT_SESSION_START, initializeFaro, TransportItemType } from '@grafana/faro-core';
import type { Config, Faro, TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingFunction } from '../../config/sampling';
import { EVENT_NAVIGATION } from '../../navigation/utils';

import { notifySessionActivity } from './directSessionActivity';
import { SessionInstrumentation, startNewSession } from './index';
import { MAX_SESSION_PERSISTENCE_TIME } from './sessionManager/sessionConstants';
import { VolatileSessionsManager } from './sessionManager/VolatileSessionManager';

const INACTIVITY_TIMEOUT = MAX_SESSION_PERSISTENCE_TIME;
const SEND_TIMEOUT = 2_000;

type SetupOptions = {
  batching?: Config['batching'];
  samplingRates?: number[];
  onSessionChange?: jest.Mock;
};

function setup({
  batching = { enabled: true, sendTimeout: SEND_TIMEOUT, itemLimit: 200 },
  samplingRates = [1, 1, 1, 1],
  onSessionChange = jest.fn(),
}: SetupOptions = {}) {
  const sessionIds = ['session-1', 'session-2', 'session-3', 'session-4'];
  const transport = new MockTransport();
  const faro = initializeFaro(
    mockConfig({
      url: 'http://localhost:12345/collect',
      transports: [transport],
      instrumentations: [new SessionInstrumentation()],
      batching,
      sessionTracking: {
        enabled: true,
        persistent: false,
        generateSessionId: () => sessionIds.shift() ?? 'fallback-session',
        onSessionChange,
        sampling: new SamplingFunction(() => samplingRates.shift() ?? 1),
      },
    })
  );

  return { faro, transport, onSessionChange };
}

function itemName(item: TransportItem): string | undefined {
  return (item.payload as { name?: string }).name;
}

function sessionOf(transport: MockTransport, name: string): string | undefined {
  return transport.items.find((item) => itemName(item) === name)?.meta.session?.id;
}

function sessionStarts(transport: MockTransport): Array<string | undefined> {
  return transport.items.filter((item) => itemName(item) === EVENT_SESSION_START).map((item) => item.meta.session?.id);
}

describe('session tracking with batching', () => {
  let faro: Faro | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    VolatileSessionsManager.removeUserSession();
  });

  afterEach(() => {
    faro?.instrumentations.instrumentations.forEach((instrumentation) => instrumentation.unpatch?.());
    faro = undefined;
    VolatileSessionsManager.removeUserSession();
    jest.useRealTimers();
  });

  it('keeps the session alive for activity captured before expiry but sent after it', () => {
    const setupResult = setup();
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT - 500);
    faro.api.pushEvent(EVENT_NAVIGATION);
    // The queue is sent after the original inactivity window has passed.
    jest.advanceTimersByTime(SEND_TIMEOUT);
    faro.api.pushEvent('after-flush');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(sessionOf(setupResult.transport, EVENT_NAVIGATION)).toBe('session-1');
    expect(sessionOf(setupResult.transport, 'after-flush')).toBe('session-1');
    expect(sessionStarts(setupResult.transport)).toEqual(['session-1']);
  });

  it('records activity in capture order when the queue is grouped by view', () => {
    const setupResult = setup();
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT - SEND_TIMEOUT);
    faro.api.setView({ name: 'A' });
    faro.api.pushEvent('in-a');
    faro.api.setView({ name: 'B' });
    faro.api.pushEvent(EVENT_NAVIGATION);
    faro.api.setView({ name: 'A' });
    // Captured after the navigation, so the navigation keeps session-1 alive.
    jest.advanceTimersByTime(SEND_TIMEOUT - 1);
    faro.api.pushEvent('back-in-a');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    const sent = setupResult.transport.items.filter((item) => itemName(item) !== EVENT_SESSION_START);
    expect(sent.map((item) => item.meta.session?.id)).toEqual(sent.map(() => 'session-1'));
    expect(sessionStarts(setupResult.transport)).toEqual(['session-1']);
  });

  it('does not let direct activity see stale state while activity is queued', () => {
    const setupResult = setup();
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT - 500);
    faro.api.pushEvent(EVENT_NAVIGATION);
    jest.advanceTimersByTime(1_000);
    // Expired if the queued navigation had not been recorded yet.
    notifySessionActivity();
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(faro.api.getSession()?.id).toBe('session-1');
    expect(sessionStarts(setupResult.transport)).toEqual(['session-1']);
  });

  it('starts one session per inactivity window covered by a single delayed batch', () => {
    const setupResult = setup({ batching: { enabled: true, sendTimeout: 0, itemLimit: 6 } });
    faro = setupResult.faro;

    faro.api.pushEvent('first');
    jest.advanceTimersByTime(INACTIVITY_TIMEOUT + 1_000);
    faro.api.pushEvent(EVENT_NAVIGATION);
    jest.advanceTimersByTime(INACTIVITY_TIMEOUT + 1_000);
    // Fills the batch, so all items are sent together.
    faro.api.pushEvent('third');

    expect(setupResult.transport.items).toHaveLength(6);
    expect(sessionOf(setupResult.transport, 'first')).toBe('session-1');
    expect(sessionOf(setupResult.transport, EVENT_NAVIGATION)).toBe('session-2');
    expect(sessionOf(setupResult.transport, 'third')).toBe('session-3');
    expect(sessionStarts(setupResult.transport)).toEqual(['session-1', 'session-2', 'session-3']);
    expect(setupResult.onSessionChange).toHaveBeenCalledTimes(2);
  });

  it('keeps a trace in the session it was captured in', () => {
    // session-2 would be unsampled, so a moved trace would be dropped.
    const setupResult = setup({ samplingRates: [1, 0] });
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT - 500);
    faro.api.pushTraces({ resourceSpans: [] });
    faro.api.pushEvent('with-trace');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    const trace = setupResult.transport.items.find((item) => item.type === TransportItemType.TRACE);
    expect(trace?.meta.session?.id).toBe('session-1');
    expect(sessionOf(setupResult.transport, 'with-trace')).toBe('session-1');
  });

  it('sends session_start for every session, including one replaced before the flush', () => {
    const setupResult = setup();
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT + 1_000);
    faro.api.pushEvent('in-session-2');
    startNewSession();
    faro.api.pushEvent('in-session-3');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(sessionOf(setupResult.transport, 'in-session-2')).toBe('session-2');
    expect(sessionOf(setupResult.transport, 'in-session-3')).toBe('session-3');
    expect(sessionStarts(setupResult.transport)).toEqual(['session-1', 'session-2', 'session-3']);
  });

  it('sends telemetry pushed from onSessionChange during a rollover', () => {
    const onSessionChange = jest.fn(() => faro?.api.pushEvent('from-callback'));
    const setupResult = setup({ onSessionChange });
    faro = setupResult.faro;

    jest.advanceTimersByTime(INACTIVITY_TIMEOUT + 1_000);
    faro.api.pushEvent('trigger');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(sessionOf(setupResult.transport, 'from-callback')).toBe('session-2');
    expect(sessionOf(setupResult.transport, 'trigger')).toBe('session-2');
  });

  it('drops queued items of an unsampled session and sends the rest without the sampling marker', () => {
    const setupResult = setup({ samplingRates: [0, 1] });
    faro = setupResult.faro;

    faro.api.pushEvent('unsampled');
    jest.advanceTimersByTime(INACTIVITY_TIMEOUT + 1_000);
    faro.api.pushEvent('sampled');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(sessionOf(setupResult.transport, 'unsampled')).toBeUndefined();
    const sampled = setupResult.transport.items.find((item) => itemName(item) === 'sampled');
    expect(sampled?.meta.session?.id).toBe('session-2');
    expect(sampled?.meta.session?.attributes?.['isSampled']).toBeUndefined();
  });

  it('runs session bookkeeping once per item when an unbatched transport is also present', () => {
    const unbatched = new MockTransport();
    jest.spyOn(unbatched, 'isBatched').mockReturnValue(false);
    const checkSession = jest.spyOn(VolatileSessionsManager.prototype, 'checkSession');
    const setupResult = setup();
    faro = setupResult.faro;
    faro.transports.add(unbatched);
    checkSession.mockClear();

    faro.api.pushEvent('both');
    jest.advanceTimersByTime(SEND_TIMEOUT);

    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(sessionOf(unbatched, 'both')).toBe('session-1');
    expect(sessionOf(setupResult.transport, 'both')).toBe('session-1');
  });
});
