import { type ExceptionEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingRate } from '../../config/sampling';
import { SessionInstrumentation } from '../session';
import { VolatileSessionsManager } from '../session/sessionManager/VolatileSessionManager';

import { ErrorsInstrumentation } from './index';

// Mock React Native's global error handler
const mockGlobal = global as any;
const originalErrorUtils = mockGlobal.ErrorUtils;

beforeEach(() => {
  // Set up ErrorUtils mock
  mockGlobal.ErrorUtils = {
    getGlobalHandler: jest.fn(() => jest.fn()),
    setGlobalHandler: jest.fn(),
  };

  // Set up event listener mocks
  mockGlobal.addEventListener = jest.fn();
  mockGlobal.removeEventListener = jest.fn();
});

afterEach(() => {
  // Restore original ErrorUtils
  if (originalErrorUtils) {
    mockGlobal.ErrorUtils = originalErrorUtils;
  } else {
    delete mockGlobal.ErrorUtils;
  }

  // Clean up event listeners
  delete mockGlobal.addEventListener;
  delete mockGlobal.removeEventListener;
});

describe('ErrorsInstrumentation', () => {
  describe('initialization', () => {
    it('should initialize and set up global error handler', () => {
      const transport = new MockTransport();
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      expect(mockGlobal.ErrorUtils.setGlobalHandler).toHaveBeenCalled();
      expect(mockGlobal.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    });

    it('should have correct name and version', () => {
      const instrumentation = new ErrorsInstrumentation();
      expect(instrumentation.name).toBe('@grafana/faro-react-native-errors');
      expect(instrumentation.version).toBe('1.0.0');
    });
  });

  describe('error handling', () => {
    it('should capture and report errors', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const testError = new Error('Test error');
      errorHandler(testError, false);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.type).toBe('Error');
      expect(item.payload.value).toBe('Test error');
      expect(item.payload.context?.mechanism).toBe('uncaught');
      expect(item.payload.fatal).toBe(false);
    });

    it('should include mechanism in context and use error.name for type (TypeError)', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const typeError = new TypeError('Cannot read property "x" of undefined');
      errorHandler(typeError, false);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.type).toBe('TypeError');
      expect(item.payload.context?.mechanism).toBe('uncaught');
    });

    it('should use the React Native fatal signal for global JavaScript errors', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const testError = new Error('Fatal error');
      errorHandler(testError, true);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.fatal).toBe(true);
      expect(item.payload.context?.isFatal).toBeUndefined();
    });

    it('should call original error handler', () => {
      const originalHandler = jest.fn();
      mockGlobal.ErrorUtils.getGlobalHandler = jest.fn(() => originalHandler);

      let errorHandler: any;
      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      const transport = new MockTransport();
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const testError = new Error('Test error');
      errorHandler(testError, false);

      expect(originalHandler).toHaveBeenCalledWith(testError, false);
    });
  });

  describe('ignoreErrors', () => {
    it('should ignore errors matching patterns', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              ignoreErrors: [/network timeout/i, /cancelled/i],
            }),
          ],
        })
      );

      // This error should be ignored
      errorHandler(new Error('Network timeout occurred'), false);
      expect(transport.items).toHaveLength(0);

      // This error should be ignored
      errorHandler(new Error('Request cancelled'), false);
      expect(transport.items).toHaveLength(0);

      // This error should be reported
      errorHandler(new Error('Something else failed'), false);
      expect(transport.items).toHaveLength(1);
    });

    it('should not crash on errors without message', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              ignoreErrors: [/test/],
            }),
          ],
        })
      );

      const errorWithoutMessage = { name: 'Error' } as Error;
      expect(() => errorHandler(errorWithoutMessage, false)).not.toThrow();
    });
  });

  describe('error deduplication', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should deduplicate identical errors within time window', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: true,
              deduplicationWindow: 5000,
            }),
          ],
        })
      );

      const error1 = new Error('Duplicate error');
      error1.stack = 'same stack';

      const error2 = new Error('Duplicate error');
      error2.stack = 'same stack';

      // First error should be reported
      errorHandler(error1, false);
      expect(transport.items).toHaveLength(1);

      // Second identical error should be deduplicated
      errorHandler(error2, false);
      expect(transport.items).toHaveLength(1);

      // Third identical error should still be deduplicated
      errorHandler(error2, false);
      expect(transport.items).toHaveLength(1);
    });

    it('should not deduplicate different errors', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: true,
            }),
          ],
        })
      );

      errorHandler(new Error('Error 1'), false);
      errorHandler(new Error('Error 2'), false);
      errorHandler(new Error('Error 3'), false);

      expect(transport.items).toHaveLength(3);
    });

    it('should respect maxDeduplicationEntries', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: true,
              maxDeduplicationEntries: 2,
            }),
          ],
        })
      );

      // Add 3 different errors (max is 2, so oldest should be removed)
      errorHandler(new Error('Error 1'), false);
      errorHandler(new Error('Error 2'), false);
      errorHandler(new Error('Error 3'), false);

      expect(transport.items).toHaveLength(3);

      // First error should now be reported again (it was removed from tracking)
      const error1Again = new Error('Error 1');
      errorHandler(error1Again, false);
      expect(transport.items).toHaveLength(4);
    });

    it('should allow disabling deduplication', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: false,
            }),
          ],
        })
      );

      // Create errors with different messages to avoid deduplication
      const error1 = new Error('Error 1');
      const error2 = new Error('Error 2');
      const error3 = new Error('Error 3');

      errorHandler(error1, false);
      errorHandler(error2, false);
      errorHandler(error3, false);

      // With deduplication disabled, all 3 different errors should be reported
      expect(transport.items).toHaveLength(3);
    });
  });

  describe('unhandled promise rejections', () => {
    it('should capture unhandled promise rejections', () => {
      const transport = new MockTransport();
      let rejectionHandler: any;

      mockGlobal.addEventListener = jest.fn((event, handler) => {
        if (event === 'unhandledrejection') {
          rejectionHandler = handler;
        }
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const testError = new Error('Rejected promise');
      rejectionHandler({ reason: testError } as PromiseRejectionEvent);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.value).toBe('Rejected promise');
    });

    it('should convert non-Error rejections to Errors with type UnhandledRejection and mechanism', () => {
      const transport = new MockTransport();
      let rejectionHandler: any;

      mockGlobal.addEventListener = jest.fn((event, handler) => {
        if (event === 'unhandledrejection') {
          rejectionHandler = handler;
        }
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      rejectionHandler({ reason: 'String rejection' } as PromiseRejectionEvent);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.type).toBe('UnhandledRejection');
      expect(item.payload.value).toContain('Unhandled Promise Rejection');
      expect(item.payload.value).toContain('String rejection');
      expect(item.payload.context?.mechanism).toBe('unhandledrejection');
      expect(item.payload.fatal).toBe(false);
    });

    it('should use actual error type for Error rejections with mechanism', () => {
      const transport = new MockTransport();
      let rejectionHandler: any;

      mockGlobal.addEventListener = jest.fn((event, handler) => {
        if (event === 'unhandledrejection') {
          rejectionHandler = handler;
        }
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const typeError = new TypeError('Something went wrong');
      rejectionHandler({ reason: typeError } as PromiseRejectionEvent);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.type).toBe('TypeError');
      expect(item.payload.context?.mechanism).toBe('unhandledrejection');
    });

    it('should handle object rejections', () => {
      const transport = new MockTransport();
      let rejectionHandler: any;

      mockGlobal.addEventListener = jest.fn((event, handler) => {
        if (event === 'unhandledrejection') {
          rejectionHandler = handler;
        }
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      rejectionHandler({ reason: { code: 'ERR_FAILED', message: 'Request failed' } } as PromiseRejectionEvent);

      expect(transport.items).toHaveLength(1);
      const item = transport.items[0] as TransportItem<ExceptionEvent>;
      expect(item.payload.value).toContain('Unhandled Promise Rejection');
    });
  });

  describe('unpatch', () => {
    it('should restore original error handler', () => {
      const originalHandler = jest.fn();
      mockGlobal.ErrorUtils.getGlobalHandler = jest.fn(() => originalHandler);

      const transport = new MockTransport();
      const { config } = initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      // Unpatch the instrumentation
      config.instrumentations?.[0]?.unpatch?.();

      expect(mockGlobal.ErrorUtils.setGlobalHandler).toHaveBeenCalledWith(originalHandler);
      expect(mockGlobal.removeEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    });

    it('should clear error fingerprints on unpatch', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      const { config } = initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: true,
            }),
          ],
        })
      );

      const error = new Error('Test error');
      error.stack = 'stack';

      // Report error
      errorHandler(error, false);
      expect(transport.items).toHaveLength(1);

      // Unpatch
      config.instrumentations?.[0]?.unpatch?.();

      // Set up new handler to test that fingerprints were cleared
      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      // Re-initialize
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [
            new ErrorsInstrumentation({
              enableDeduplication: true,
            }),
          ],
        })
      );

      // Same error should be reported again (fingerprints were cleared)
      errorHandler(error, false);
      expect(transport.items).toHaveLength(2);
    });
  });

  describe('error handling resilience', () => {
    it('should not crash if error reporting fails', () => {
      let errorHandler: any;
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      // Create a transport that throws
      const failingTransport = {
        isBatched: () => false,
        send: jest.fn(() => {
          throw new Error('Transport failed');
        }),
      };

      initializeFaro(
        mockConfig({
          transports: [failingTransport as any],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const testError = new Error('Test error');
      expect(() => errorHandler(testError, false)).not.toThrow();
      consoleErrorSpy.mockRestore();
    });

    it('should handle errors without stack', () => {
      const transport = new MockTransport();
      let errorHandler: any;

      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      const errorWithoutStack = new Error('No stack');
      errorWithoutStack.stack = undefined;

      expect(() => errorHandler(errorWithoutStack, false)).not.toThrow();
      expect(transport.items).toHaveLength(1);
    });

    it.each([
      ['a null-prototype object', () => Object.create(null)],
      [
        'an object with a throwing toString',
        () => ({
          toString: () => {
            throw new Error('toString exploded');
          },
        }),
      ],
    ])('should still forward %s to the original handler', (_name, makeThrown) => {
      const originalHandler = jest.fn();
      mockGlobal.ErrorUtils.getGlobalHandler = jest.fn(() => originalHandler);

      let errorHandler: any;
      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });

      const transport = new MockTransport();
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
        })
      );

      // String(thrown) throws for these values, so Faro cannot report them.
      // React Native's handler must still see the original value and flag.
      const thrown = makeThrown();
      expect(() => errorHandler(thrown, true)).not.toThrow();
      expect(originalHandler).toHaveBeenCalledWith(thrown, true);
      expect(transport.items).toHaveLength(0);
    });
  });

  describe('with batching', () => {
    const batching = { enabled: true, sendTimeout: 2_000, itemLimit: 200 };

    beforeEach(() => {
      jest.useFakeTimers();
      VolatileSessionsManager.removeUserSession();
    });

    afterEach(() => {
      jest.useRealTimers();
      VolatileSessionsManager.removeUserSession();
    });

    function setup(config: Parameters<typeof mockConfig>[0] = {}) {
      const transport = new MockTransport();
      const send = jest.spyOn(transport, 'send');
      let errorHandler: (error: unknown, isFatal: boolean) => void = () => {};
      // Records what was sent when React Native's own handler runs, which can exit the app.
      let sentBeforeOriginalHandler: TransportItem[] | undefined;
      mockGlobal.ErrorUtils.getGlobalHandler = jest.fn(() =>
        jest.fn(() => {
          sentBeforeOriginalHandler = [...transport.items];
        })
      );
      mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
        errorHandler = handler;
      });
      const faro = initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [new ErrorsInstrumentation()],
          batching,
          ...config,
        })
      );
      jest.advanceTimersByTime(batching.sendTimeout);
      transport.items = [];
      send.mockClear();

      return {
        faro,
        transport,
        send,
        throwError: (error: Error, isFatal: boolean) => errorHandler(error, isFatal),
        sentBeforeOriginalHandler: () => sentBeforeOriginalHandler,
      };
    }

    function exceptions(transport: MockTransport) {
      return transport.items.filter((item) => item.type === 'exception') as Array<TransportItem<ExceptionEvent>>;
    }

    it('sends a fatal error before the original handler runs, and only once', () => {
      const setupResult = setup();

      setupResult.throwError(new Error('fatal'), true);

      expect(setupResult.sentBeforeOriginalHandler()?.map((item) => item.payload)).toEqual([
        expect.objectContaining({ value: 'fatal', fatal: true }),
      ]);
      jest.advanceTimersByTime(batching.sendTimeout * 2);
      expect(exceptions(setupResult.transport)).toHaveLength(1);
    });

    it('keeps batching non-fatal errors and telemetry pushed after a fatal error', () => {
      const setupResult = setup();

      setupResult.throwError(new Error('non-fatal'), false);
      expect(setupResult.sentBeforeOriginalHandler()).toEqual([]);

      setupResult.throwError(new Error('fatal'), true);
      setupResult.faro.api.pushEvent('after-fatal');
      expect(setupResult.transport.items.map((item) => (item.payload as { value?: string }).value)).toEqual(['fatal']);

      jest.advanceTimersByTime(batching.sendTimeout);
      expect(exceptions(setupResult.transport).map((item) => item.payload.value)).toEqual(['fatal', 'non-fatal']);
      expect(
        setupResult.transport.items.some((item) => (item.payload as { name?: string }).name === 'after-fatal')
      ).toBe(true);
    });

    it('applies beforeSend once to a fatal error', () => {
      const beforeSend = jest.fn((item: TransportItem) => ({
        ...item,
        meta: { ...item.meta, user: undefined },
      }));
      const setupResult = setup({ beforeSend });
      setupResult.faro.api.setUser({ id: 'user-1' });
      beforeSend.mockClear();

      setupResult.throwError(new Error('fatal'), true);

      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(exceptions(setupResult.transport)[0]?.meta.user).toBeUndefined();
    });

    it('drops a fatal error that beforeSend filters out', () => {
      const setupResult = setup({ beforeSend: (item) => (item.type === 'exception' ? null : item) });

      setupResult.throwError(new Error('fatal'), true);
      jest.advanceTimersByTime(batching.sendTimeout);

      expect(exceptions(setupResult.transport)).toHaveLength(0);
    });

    it('does not send a fatal error while paused', () => {
      const setupResult = setup();
      setupResult.faro.pause();

      setupResult.throwError(new Error('fatal'), true);

      expect(setupResult.send).not.toHaveBeenCalled();
    });

    it.each([
      ['sampled', 1, 1],
      ['unsampled', 0, 0],
    ] as const)(
      'applies session attribution and sampling to a fatal error in a %s session',
      (_name, rate, expected) => {
        const transport = new MockTransport();
        let errorHandler: (error: unknown, isFatal: boolean) => void = () => {};
        mockGlobal.ErrorUtils.setGlobalHandler = jest.fn((handler) => {
          errorHandler = handler;
        });
        const sessionInstrumentation = new SessionInstrumentation();
        initializeFaro(
          mockConfig({
            transports: [transport],
            instrumentations: [sessionInstrumentation, new ErrorsInstrumentation()],
            batching,
            sessionTracking: { enabled: true, persistent: false, sampling: new SamplingRate(rate) },
          })
        );
        const sessionId = VolatileSessionsManager.fetchUserSession()?.sessionId;

        try {
          errorHandler(new Error('fatal'), true);

          const sent = exceptions(transport);
          expect(sent).toHaveLength(expected);
          if (expected === 1) {
            expect(sent[0]?.meta.session?.id).toBe(sessionId);
            expect(sent[0]?.meta.session?.attributes?.['isSampled']).toBeUndefined();
          }
        } finally {
          sessionInstrumentation.unpatch();
        }
      }
    );
  });
});
