import {
  getTransportBody,
  initializeFaro,
  LogEvent,
  LogLevel,
  TransportItem,
  TransportItemType,
} from '@grafana/faro-core';
import { mockConfig, mockInternalLogger } from '@grafana/faro-test-utils';

import { FetchTransport } from './transport';

const fetch = jest.fn(() =>
  Promise.resolve({
    status: 202,
    text: () => Promise.resolve(),
    headers: {
      get: (_name?: string): string | null => null,
    },
  })
);

(global as any).fetch = fetch;

const mockSessionId = '123';

const item: TransportItem<LogEvent> = {
  type: TransportItemType.LOG,
  payload: {
    context: {},
    level: LogLevel.INFO,
    message: 'hi',
    timestamp: new Date().toISOString(),
  },
  meta: {
    session: { id: mockSessionId },
  },
};

const largeItem: TransportItem<LogEvent> = {
  type: TransportItemType.LOG,
  payload: {
    context: {},
    level: LogLevel.INFO,
    message: 'I'.repeat(60_000),
    timestamp: new Date().toISOString(),
  },
  meta: {
    session: { id: mockSessionId },
  },
};

describe('FetchTransport', () => {
  beforeEach(() => {
    fetch.mockClear();
    jest.clearAllMocks();
    jest.clearAllTimers();
    // Reset fetch implementation to default
    fetch.mockImplementation(() =>
      Promise.resolve({
        status: 202,
        text: () => Promise.resolve(),
        headers: {
          get: (_name?: string): string | null => null,
        },
      })
    );
  });

  afterEach(() => {
    // Ensure all pending timers are cleared between tests
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('will send event over fetch', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    transport.metas.value = { session: { id: mockSessionId } };

    transport.internalLogger = mockInternalLogger;

    await transport.send([item]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([item])),
        headers: {
          'Content-Type': 'application/json',
          'x-faro-session-id': mockSessionId,
        },
        method: 'POST',
      })
    );
  });

  it('uses the live session for the header while preserving the payload session', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });
    const waitForSession = jest
      .spyOn(transport as unknown as { waitForSession: () => Promise<void> }, 'waitForSession')
      .mockResolvedValue();

    transport.metas.value = { session: { id: 'new-live-session' } };
    transport.internalLogger = mockInternalLogger;

    await transport.send([item]);

    expect(waitForSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([item])),
        headers: {
          'Content-Type': 'application/json',
          'x-faro-session-id': 'new-live-session',
        },
        method: 'POST',
      })
    );
  });

  it('returns whether the collector accepted the payload', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    await expect(transport.sendWithResult([item])).resolves.toEqual({
      outcome: 'accepted',
      status: 202,
    });

    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        status: 500,
        text: () => Promise.resolve('server error'),
        headers: {
          get: () => null,
        },
      })
    );

    await expect(transport.sendWithResult([item])).resolves.toEqual({
      outcome: 'rejected',
      status: 500,
    });

    fetch.mockImplementationOnce(() => Promise.reject(new Error('Network error')));

    await expect(transport.sendWithResult([item])).resolves.toEqual({
      outcome: 'failed',
    });
  });

  it('skips empty batches without sending a request', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    transport.internalLogger = mockInternalLogger;

    await expect(transport.sendWithResult([])).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('will send event with API key if provided', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      apiKey: 'test-api-key',
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    await transport.send([item]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([item])),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'test-api-key',
          'x-faro-session-id': mockSessionId,
        },
        method: 'POST',
      })
    );
  });

  it('will not send events if buffer size is exhausted', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      bufferSize: 3,
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    // Send 6 items but buffer size is 3
    const sendPromises = [];
    for (let idx = 0; idx < 6; idx++) {
      sendPromises.push(transport.send([item]));
    }

    await Promise.all(sendPromises);

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('will back off on 429 for default interval if no retry-after header present', async () => {
    let now = Date.now();

    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      defaultRateLimitBackoffMs: 1000,
      getNow: () => now,
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        status: 429,
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(),
      })
    );

    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1001;
    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('will back off on 429 for retry-after header with delay in seconds', async () => {
    let now = Date.now();

    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      defaultRateLimitBackoffMs: 1000,
      getNow: () => now,
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        status: 429,
        headers: {
          get: () => '2', // 2 seconds
        },
        text: () => Promise.resolve(),
      })
    );

    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1001;
    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1001;
    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('will back off on 429 for retry-after header with date', async () => {
    let now = Date.now();

    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      defaultRateLimitBackoffMs: 1000,
      getNow: () => now,
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    fetch.mockImplementationOnce(() =>
      Promise.resolve({
        status: 429,
        headers: {
          get: () => new Date(now + 3000).toISOString(),
        },
        text: () => Promise.resolve(),
      })
    );

    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1001;
    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2001;
    await transport.send([item]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('will handle large payloads', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    await transport.send([largeItem]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([largeItem])),
        headers: {
          'Content-Type': 'application/json',
          'x-faro-session-id': mockSessionId,
        },
        method: 'POST',
      })
    );
  });

  it('will add global ignoredURLs to the ignoredUrls list', () => {
    const collectorUrl = 'http://example.com/collect';

    const transport = new FetchTransport({
      url: collectorUrl,
    });

    const globalIgnoreUrls = [/.*foo-analytics/, 'http://example-analytics.com'];

    const config = mockConfig({
      transports: [transport],
      ignoreUrls: globalIgnoreUrls,
    });

    const faro = initializeFaro(config);

    transport.internalLogger = mockInternalLogger;

    const ignoreUrls = faro.transports.transports.flatMap((transport) => transport.getIgnoreUrls());
    expect(ignoreUrls).toStrictEqual([collectorUrl, ...globalIgnoreUrls]);
  });

  it('handles fetch errors gracefully', async () => {
    fetch.mockImplementationOnce(() => Promise.reject(new Error('Network error')));

    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    // Should not throw
    await expect(transport.send([item])).resolves.not.toThrow();

    // Verify fetch was called (and failed)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supports custom request options', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
      requestOptions: {
        headers: {
          'X-Custom-Header': 'custom-value',
        },
        credentials: 'include',
      },
    });

    transport.metas.value = { session: { id: mockSessionId } };
    transport.internalLogger = mockInternalLogger;

    await transport.send([item]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([item])),
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
          'x-faro-session-id': mockSessionId,
        },
        method: 'POST',
        credentials: 'include',
      })
    );
  });

  it('isBatched returns true', () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });

    expect(transport.isBatched()).toBe(true);
  });

  it('sends without session ID if no session is available', async () => {
    const transport = new FetchTransport({
      url: 'http://example.com/collect',
    });
    const waitForSession = jest
      .spyOn(transport as unknown as { waitForSession: () => Promise<void> }, 'waitForSession')
      .mockResolvedValue();

    transport.metas.value = {};
    transport.internalLogger = mockInternalLogger;

    const itemWithoutSession = {
      ...item,
      meta: {},
    };

    await transport.send([itemWithoutSession]);

    expect(waitForSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.com/collect',
      expect.objectContaining({
        body: JSON.stringify(getTransportBody([itemWithoutSession])),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
  });

  describe('items with different metadata', () => {
    function itemWithMeta(message: string, userId?: string): TransportItem<LogEvent> {
      return {
        ...item,
        payload: { ...item.payload, message },
        meta: { session: { id: mockSessionId }, ...(userId ? { user: { id: userId } } : {}) },
      };
    }

    function sentBodies() {
      return fetch.mock.calls.map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body));
    }

    function createTransport(options: Partial<ConstructorParameters<typeof FetchTransport>[0]> = {}) {
      const transport = new FetchTransport({ url: 'http://example.com/collect', ...options });
      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;
      return transport;
    }

    it.each([
      ['user first', [itemWithMeta('with-user', 'user-1'), itemWithMeta('without-user')]],
      ['user last', [itemWithMeta('without-user'), itemWithMeta('with-user', 'user-1')]],
    ])('sends each meta in its own request (%s)', async (_order, items) => {
      await createTransport().send(items);

      const bodies = sentBodies();
      expect(bodies).toHaveLength(2);
      const withUser = bodies.find((body) => body.logs[0].message === 'with-user');
      const withoutUser = bodies.find((body) => body.logs[0].message === 'without-user');
      expect(withUser.meta.user).toEqual({ id: 'user-1' });
      expect(withUser.logs).toHaveLength(1);
      expect(withoutUser.meta.user).toBeUndefined();
      expect(withoutUser.logs).toHaveLength(1);
    });

    it('sends items with the same meta in one request, in order', async () => {
      await createTransport().send([itemWithMeta('a', 'user-1'), itemWithMeta('b'), itemWithMeta('c', 'user-1')]);

      const bodies = sentBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[0].logs.map((log: LogEvent) => log.message)).toEqual(['a', 'c']);
      expect(bodies[1].logs.map((log: LogEvent) => log.message)).toEqual(['b']);
    });

    it('does not change the items it groups', async () => {
      const items = [itemWithMeta('a', 'user-1'), itemWithMeta('b')];
      const snapshot = JSON.parse(JSON.stringify(items));

      await createTransport().send(items);

      expect(items).toEqual(snapshot);
    });

    it('sends every group of a fully mixed batch one at a time, within the request buffer', async () => {
      const resolvers: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      fetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            resolvers.push(() => {
              inFlight--;
              resolve({ status: 202, text: () => Promise.resolve(), headers: { get: () => null } });
            });
          })
      );
      const items = Array.from({ length: 200 }, (_, idx) => itemWithMeta(`item-${idx}`, `user-${idx}`));

      const sending = createTransport().send(items);
      for (let idx = 0; idx < 200; idx++) {
        // Wait for the next request to start, then complete it.
        for (let ticks = 0; resolvers.length === 0 && ticks < 100; ticks++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        resolvers.shift()?.();
      }
      await sending;

      expect(fetch).toHaveBeenCalledTimes(200);
      expect(maxInFlight).toBe(1);
      expect(sentBodies().map((body) => body.meta.user.id)).toEqual(items.map((_, idx) => `user-${idx}`));
    });

    it('shares the request buffer between overlapping sends and drops groups that do not fit', async () => {
      const resolvers: Array<() => void> = [];
      fetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ status: 202, text: () => Promise.resolve(), headers: { get: () => null } }));
          })
      );
      const transport = createTransport({ bufferSize: 2 });

      // Faro Core calls send() once per pre-hook group without awaiting, and flushes can overlap.
      const sends = ['a', 'b', 'c'].map((name) =>
        transport.send([itemWithMeta(`${name}-1`, `${name}-user`), itemWithMeta(`${name}-2`)])
      );
      for (let ticks = 0; ticks < 100 && (resolvers.length > 0 || fetch.mock.calls.length < 4); ticks++) {
        resolvers.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await Promise.all(sends);

      // Each send holds at most one slot at a time, so the first two sends deliver
      // every group. The third finds the buffer full and its groups are dropped,
      // as when the buffer is exhausted by unrelated sends.
      const delivered = sentBodies().map((body) => body.logs[0].message);
      expect(delivered.sort()).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
    });

    it('skips the remaining groups once a group is rate limited', async () => {
      fetch.mockImplementationOnce(() =>
        Promise.resolve({ status: 429, headers: { get: () => null }, text: () => Promise.resolve() })
      );

      await createTransport().send([itemWithMeta('a', 'user-1'), itemWithMeta('b', 'user-2'), itemWithMeta('c')]);

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Circuit Breaker - Offline Behavior', () => {
    it('activates circuit breaker after 3 consecutive failures', async () => {
      let now = Date.now();

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
        getNow: () => now,
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;
      (transport as any).config = { sessionTracking: { enabled: false } };

      // Mock 3 consecutive failures (simulating offline device)
      fetch.mockImplementation(() => Promise.reject(new Error('Network error')));

      // First 3 failures should increment the counter
      await transport.send([item]);
      await transport.send([item]);
      await transport.send([item]);

      expect(fetch).toHaveBeenCalledTimes(3);

      // After 3 failures, circuit breaker should be active
      // Next attempt should be silently dropped (no fetch call)
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(3); // Still 3, no new call

      // Fast forward past backoff period (30 seconds)
      now += 30001;

      // Reset fetch to succeed
      fetch.mockImplementation(() =>
        Promise.resolve({
          status: 202,
          text: () => Promise.resolve(),
          headers: {
            get: () => null,
          },
        })
      );

      // Now it should try again
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('resets failure counter on successful request', async () => {
      let now = Date.now();

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
        getNow: () => now,
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;
      (transport as any).config = { sessionTracking: { enabled: false } };

      // Mock 2 failures, then success
      fetch
        .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
        .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
        .mockImplementationOnce(() =>
          Promise.resolve({
            status: 202,
            text: () => Promise.resolve(),
            headers: {
              get: () => null,
            },
          })
        );

      await transport.send([item]); // Failure 1
      await transport.send([item]); // Failure 2
      await transport.send([item]); // Success - should reset counter

      expect(fetch).toHaveBeenCalledTimes(3);

      // Mock 2 more failures
      fetch
        .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
        .mockImplementationOnce(() => Promise.reject(new Error('Network error')));

      await transport.send([item]); // Failure 1 (counter reset, so this is first)
      await transport.send([item]); // Failure 2

      // Circuit breaker should NOT be active yet (needs 3 failures)
      await transport.send([item]); // This should still attempt
      expect(fetch).toHaveBeenCalledTimes(6); // All 6 calls were made
    });

    it('silently drops events during backoff period', async () => {
      let now = Date.now();

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
        getNow: () => now,
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;
      (transport as any).config = { sessionTracking: { enabled: false } };

      // Mock 3 consecutive failures to trigger circuit breaker
      fetch.mockImplementation(() => Promise.reject(new Error('Network error')));

      await transport.send([item]);
      await transport.send([item]);
      await transport.send([item]);

      expect(fetch).toHaveBeenCalledTimes(3);

      // During backoff period, events should be silently dropped
      await transport.send([item]);
      await transport.send([item]);
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(3); // No new calls

      // Advance time by 15 seconds (still in backoff)
      now += 15000;

      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(3); // Still no new calls

      // Advance past backoff period
      now += 15001; // Total: 30001ms

      // Should try again now
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('does not log errors to console (prevents infinite loops)', async () => {
      const consoleSpy = jest.spyOn(console, 'error');
      const consoleWarnSpy = jest.spyOn(console, 'warn');
      const consoleLogSpy = jest.spyOn(console, 'log');

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;

      // Mock failures
      fetch.mockImplementation(() => Promise.reject(new Error('Network error')));

      // Send multiple failing requests
      await transport.send([item]);
      await transport.send([item]);
      await transport.send([item]);

      // Verify NO console calls were made (to prevent infinite loops in RN)
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('handles buffer full errors silently', async () => {
      const consoleSpy = jest.spyOn(console, 'error');

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
        bufferSize: 1, // Very small buffer
        concurrency: 1,
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;
      // Disable session tracking to skip session wait
      (transport as any).config = { sessionTracking: { enabled: false } };

      // Make fetch slow to fill up buffer (using short real delays)
      fetch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  status: 202,
                  text: () => Promise.resolve(),
                  headers: {
                    get: () => null,
                  },
                }),
              10 // Short delay for tests
            )
          )
      );

      // Try to send multiple items quickly to overflow buffer
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(transport.send([item]));
      }

      await Promise.all(promises);

      // Should not log buffer full errors to console
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('continues to respect rate limiting during circuit breaker recovery', async () => {
      const timeRef = { now: Date.now() };

      const transport = new FetchTransport({
        url: 'http://example.com/collect',
        getNow: () => timeRef.now,
      });

      transport.metas.value = { session: { id: mockSessionId } };
      transport.internalLogger = mockInternalLogger;

      // Trigger rate limit (429)
      fetch.mockImplementationOnce(() =>
        Promise.resolve({
          status: 429,
          headers: {
            get: () => '5', // 5 seconds
          },
          text: () => Promise.resolve(),
        })
      );

      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Should be in rate limit backoff
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Advance past rate limit backoff (Retry-After was 5 seconds)
      timeRef.now += 6000;

      // Now trigger circuit breaker with 3 failures
      fetch.mockImplementation(() => Promise.reject(new Error('Network error')));

      await transport.send([item]);
      await transport.send([item]);
      await transport.send([item]);

      const callsAfterFailures = fetch.mock.calls.length;
      expect(callsAfterFailures).toBeGreaterThanOrEqual(3); // 1 (429) + 2+ failures
      expect(callsAfterFailures).toBeLessThanOrEqual(4); // at most 1 + 3

      // Should be in circuit breaker backoff now (no new fetch)
      await transport.send([item]);
      expect(fetch).toHaveBeenCalledTimes(callsAfterFailures); // No new call
    });
  });
});
