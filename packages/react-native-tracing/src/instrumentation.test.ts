import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Context, ContextManager, MeterProvider, TracerProvider } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';

import { getInternalFaroFromGlobalObject, initializeFaro } from '@grafana/faro-core';
import type { Faro } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { FaroTraceExporter } from './exporters/faroTraceExporter';
import { TracingInstrumentation } from './instrumentation';
import type { TracingInstrumentationOptions } from './types';

jest.mock('@grafana/faro-core', () => ({
  ...jest.requireActual('@grafana/faro-core'),
  getInternalFaroFromGlobalObject: jest.fn(),
}));

jest.mock('@grafana/faro-react-native', () => ({
  notifyHttpRequestEnd: jest.fn(),
  notifyHttpRequestStart: jest.fn(),
}));

type FaroWithOtel = Faro & { otel?: unknown };

class FetchTestInstrumentation implements Instrumentation {
  readonly instrumentationName = 'fetch-test';
  readonly instrumentationVersion = '1.0.0';

  disableCalls = 0;
  enableCalls = 0;
  requestCount = 0;

  private config: InstrumentationConfig = { enabled: false };
  private originalFetch?: typeof fetch;
  private wrappedFetch?: typeof fetch;

  disable(): void {
    this.disableCalls += 1;
    if (!this.config.enabled) {
      return;
    }

    this.config = { ...this.config, enabled: false };
    if (this.originalFetch && this.wrappedFetch && globalThis.fetch === this.wrappedFetch) {
      globalThis.fetch = this.originalFetch;
    }
    this.originalFetch = undefined;
    this.wrappedFetch = undefined;
  }

  enable(): void {
    this.enableCalls += 1;
    if (this.config.enabled) {
      return;
    }

    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof fetch = (...args) => {
      this.requestCount += 1;
      const span = trace.getTracer(this.instrumentationName).startSpan('HTTP GET');
      return originalFetch(...args).then(
        (response) => {
          span.end();
          return response;
        },
        (error: unknown) => {
          span.end();
          throw error;
        }
      );
    };
    this.config = { ...this.config, enabled: true };
    this.originalFetch = originalFetch;
    this.wrappedFetch = wrappedFetch;
    globalThis.fetch = wrappedFetch;
  }

  getConfig(): InstrumentationConfig {
    return this.config;
  }

  setConfig(config: InstrumentationConfig): void {
    this.config = { ...config };
  }

  setMeterProvider(_meterProvider: MeterProvider): void {}

  setTracerProvider(_tracerProvider: TracerProvider): void {}
}

class ThrowingDisableInstrumentation extends FetchTestInstrumentation {
  override disable(): void {
    super.disable();
    throw new Error('disable failed');
  }
}

class ThrowingEnableInstrumentation extends FetchTestInstrumentation {
  override enable(): void {
    super.enable();
    throw new Error('enable failed');
  }
}

class StatefulContextManager implements ContextManager {
  disableCalls = 0;
  enableCalls = 0;
  enabled = false;

  active(): Context {
    return ROOT_CONTEXT;
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  disable(): this {
    this.disableCalls += 1;
    this.enabled = false;
    return this;
  }

  enable(): this {
    this.enableCalls += 1;
    this.enabled = true;
    return this;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    _context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return fn.call(thisArg, ...args);
  }
}

function createSpanProcessor(
  shutdown: () => Promise<void> = async () => {},
  forceFlush: () => Promise<void> = async () => {}
): SpanProcessor {
  return {
    forceFlush: jest.fn(forceFlush),
    onEnd: jest.fn(),
    onEnding: jest.fn(),
    onStart: jest.fn(),
    shutdown: jest.fn(shutdown),
  };
}

describe('TracingInstrumentation teardown', () => {
  const getInternalFaroMock = jest.mocked(getInternalFaroFromGlobalObject);
  const tracingInstrumentations: TracingInstrumentation[] = [];
  let originalFetch: typeof fetch;

  function addTracingInstrumentation(
    otelInstrumentation: Instrumentation | Instrumentation[],
    spanProcessor: SpanProcessor,
    options: TracingInstrumentationOptions = {},
    previousFaroOtel?: unknown
  ): { faro: FaroWithOtel; tracingInstrumentation: TracingInstrumentation } {
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [new MockTransport()],
      })
    ) as FaroWithOtel;
    faro.otel = previousFaroOtel;
    getInternalFaroMock.mockReturnValue(faro);

    const tracingInstrumentation = new TracingInstrumentation({
      ...options,
      instrumentations: Array.isArray(otelInstrumentation) ? otelInstrumentation : [otelInstrumentation],
      spanProcessor,
    });
    tracingInstrumentations.push(tracingInstrumentation);
    faro.instrumentations.add(tracingInstrumentation);

    return { faro, tracingInstrumentation };
  }

  function addDefaultTracingInstrumentation(): {
    faro: FaroWithOtel;
    tracingInstrumentation: TracingInstrumentation;
  } {
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [new MockTransport()],
      })
    ) as FaroWithOtel;
    getInternalFaroMock.mockReturnValue(faro);
    const tracingInstrumentation = new TracingInstrumentation({ instrumentations: [] });
    tracingInstrumentations.push(tracingInstrumentation);
    faro.instrumentations.add(tracingInstrumentation);

    return { faro, tracingInstrumentation };
  }

  beforeEach(() => {
    trace.disable();
    context.disable();
    propagation.disable();
    getInternalFaroMock.mockReset();

    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue({
      clone: () => ({ body: null }),
      ok: true,
      status: 200,
      statusText: 'OK',
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await Promise.all(tracingInstrumentations.splice(0).map((item) => item.shutdown().catch(() => undefined)));
    jest.restoreAllMocks();
    trace.disable();
    context.disable();
    propagation.disable();
    globalThis.fetch = originalFetch;
  });

  it('detaches instrumentations before provider shutdown and cleans up once', async () => {
    const order: string[] = [];
    const otelInstrumentation = new FetchTestInstrumentation();
    const originalDisable = otelInstrumentation.disable.bind(otelInstrumentation);
    jest.spyOn(otelInstrumentation, 'disable').mockImplementation(() => {
      order.push('instrumentation');
      originalDisable();
    });
    const spanProcessor = createSpanProcessor(async () => {
      order.push('provider');
    });
    const traceDisableSpy = jest.spyOn(trace, 'disable');
    const contextDisableSpy = jest.spyOn(context, 'disable');
    const propagationDisableSpy = jest.spyOn(propagation, 'disable');
    const { faro, tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);

    expect(faro.otel).toEqual({ trace, context });
    expect(otelInstrumentation.enableCalls).toBe(1);
    await globalThis.fetch('https://example.com');
    expect(otelInstrumentation.requestCount).toBe(1);

    const firstShutdown = tracingInstrumentation.shutdown();
    const concurrentShutdown = tracingInstrumentation.shutdown();
    await Promise.all([firstShutdown, concurrentShutdown]);

    expect(order).toEqual(['instrumentation', 'provider']);
    expect(faro.otel).toBeUndefined();
    expect(traceDisableSpy).toHaveBeenCalledTimes(1);
    expect(contextDisableSpy).toHaveBeenCalledTimes(1);
    expect(propagationDisableSpy).toHaveBeenCalledTimes(1);
    await globalThis.fetch('https://example.com/after-shutdown');
    expect(otelInstrumentation.requestCount).toBe(1);

    await tracingInstrumentation.shutdown();
    expect(otelInstrumentation.disableCalls).toBe(1);
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not clear global registrations owned by another provider', async () => {
    const externalProvider = new BasicTracerProvider();
    const externalContextManager = new StackContextManager().enable();
    const externalPropagator = new W3CTraceContextPropagator();
    expect(trace.setGlobalTracerProvider(externalProvider)).toBe(true);
    expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
    expect(propagation.setGlobalPropagator(externalPropagator)).toBe(true);

    const traceDisableSpy = jest.spyOn(trace, 'disable');
    const contextDisableSpy = jest.spyOn(context, 'disable');
    const propagationDisableSpy = jest.spyOn(propagation, 'disable');
    const contextManagerDisableSpy = jest.spyOn(externalContextManager, 'disable');
    const previousFaroOtel = { owner: 'existing' };
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation } = addTracingInstrumentation(
      otelInstrumentation,
      spanProcessor,
      {
        contextManager: externalContextManager,
        propagator: externalPropagator,
      },
      previousFaroOtel
    );

    await tracingInstrumentation.shutdown();

    expect(traceDisableSpy).not.toHaveBeenCalled();
    expect(contextDisableSpy).not.toHaveBeenCalled();
    expect(propagationDisableSpy).not.toHaveBeenCalled();
    expect(contextManagerDisableSpy).not.toHaveBeenCalled();
    expect(faro.otel).toBe(previousFaroOtel);
    await externalProvider.shutdown();
  });

  it('disables an unused default context manager without clearing the active one', async () => {
    const externalContextManager = new StackContextManager().enable();
    expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
    const externalDisableSpy = jest.spyOn(externalContextManager, 'disable');
    const defaultDisableSpy = jest.spyOn(StackContextManager.prototype, 'disable');
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor();
    const { tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);

    await tracingInstrumentation.shutdown();

    expect(externalDisableSpy).not.toHaveBeenCalled();
    expect(defaultDisableSpy).toHaveBeenCalledTimes(1);
  });

  it('detaches synchronously during Faro removal and handles flush rejection', async () => {
    const flushError = new Error('provider flush failed');
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor(
      async () => {},
      async () => {
        throw flushError;
      }
    );
    const { faro, tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);
    const loggerSpy = jest.spyOn(faro.internalLogger, 'error').mockImplementation(() => {});

    faro.instrumentations.remove(tracingInstrumentation);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(otelInstrumentation.disableCalls).toBe(1);
    expect(faro.otel).toBeUndefined();
    expect(faro.instrumentations.instrumentations).not.toContain(tracingInstrumentation);
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('@grafana/faro-react-native-tracing'),
      expect.stringContaining('Failed to flush the OpenTelemetry tracer provider'),
      expect.arrayContaining([flushError])
    );
    expect(spanProcessor.shutdown).not.toHaveBeenCalled();

    await tracingInstrumentation.shutdown();
    expect(otelInstrumentation.disableCalls).toBe(1);
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('finishes cleanup when an instrumentation throws while disabling', async () => {
    const throwingInstrumentation = new ThrowingDisableInstrumentation();
    const followingInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor();
    const traceDisableSpy = jest.spyOn(trace, 'disable');
    const { faro, tracingInstrumentation } = addTracingInstrumentation(
      [throwingInstrumentation, followingInstrumentation],
      spanProcessor
    );
    const loggerSpy = jest.spyOn(faro.internalLogger, 'error').mockImplementation(() => {});

    await tracingInstrumentation.shutdown();

    expect(throwingInstrumentation.disableCalls).toBe(2);
    expect(followingInstrumentation.disableCalls).toBe(1);
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
    expect(traceDisableSpy).toHaveBeenCalledTimes(1);
    expect(faro.otel).toBeUndefined();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('@grafana/faro-react-native-tracing'),
      expect.stringContaining('Failed to unregister'),
      expect.any(Error)
    );
  });

  it('detaches before propagating an explicit shutdown failure', async () => {
    const shutdownError = new Error('provider shutdown failed');
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor(async () => {
      throw shutdownError;
    });
    const { faro, tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);

    await expect(tracingInstrumentation.shutdown()).rejects.toBe(shutdownError);

    expect(otelInstrumentation.disableCalls).toBe(1);
    expect(faro.otel).toBeUndefined();
    await globalThis.fetch('https://example.com/after-failed-shutdown');
    expect(otelInstrumentation.requestCount).toBe(0);
  });

  it('releases a supplied processor after removal when its shutdown throws synchronously', async () => {
    const shutdownError = new Error('provider shutdown threw');
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor(() => {
      throw shutdownError;
    });
    const { faro, tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);
    faro.instrumentations.remove(tracingInstrumentation);

    expect(otelInstrumentation.disableCalls).toBe(1);
    await expect(tracingInstrumentation.shutdown()).rejects.toBe(shutdownError);
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not replace a newer faro.otel owner during cleanup', async () => {
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);
    const replacementOtel = { owner: 'replacement' };
    faro.otel = replacementOtel;

    await tracingInstrumentation.shutdown();

    expect(faro.otel).toBe(replacementOtel);
  });

  it('waits for every provider cleanup before shutting down a supplied processor', async () => {
    let resolveFirstFlush: () => void = () => {};
    let resolveSecondFlush: () => void = () => {};
    const firstFlush = new Promise<void>((resolve) => {
      resolveFirstFlush = resolve;
    });
    const secondFlush = new Promise<void>((resolve) => {
      resolveSecondFlush = resolve;
    });
    const forceFlush = jest.fn().mockReturnValueOnce(firstFlush).mockReturnValueOnce(secondFlush);
    const otelInstrumentation = new FetchTestInstrumentation();
    const spanProcessor = createSpanProcessor(async () => {}, forceFlush);
    const { tracingInstrumentation } = addTracingInstrumentation(otelInstrumentation, spanProcessor);

    tracingInstrumentation.initialize();
    const finalShutdown = tracingInstrumentation.shutdown();
    let finalShutdownSettled = false;
    void finalShutdown.then(
      () => {
        finalShutdownSettled = true;
      },
      () => {
        finalShutdownSettled = true;
      }
    );

    resolveFirstFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finalShutdownSettled).toBe(false);
    expect(spanProcessor.shutdown).not.toHaveBeenCalled();

    resolveSecondFlush();
    await expect(finalShutdown).resolves.toBeUndefined();
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('rolls back registrations when initialization fails', async () => {
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [new MockTransport()],
      })
    ) as FaroWithOtel;
    getInternalFaroMock.mockReturnValue(faro);
    const baseFetch = globalThis.fetch;
    const otelInstrumentation = new ThrowingEnableInstrumentation();
    const spanProcessor = createSpanProcessor();
    const traceDisableSpy = jest.spyOn(trace, 'disable');
    const contextDisableSpy = jest.spyOn(context, 'disable');
    const propagationDisableSpy = jest.spyOn(propagation, 'disable');
    const tracingInstrumentation = new TracingInstrumentation({
      instrumentations: [otelInstrumentation],
      spanProcessor,
    });
    tracingInstrumentations.push(tracingInstrumentation);

    expect(() => faro.instrumentations.add(tracingInstrumentation)).toThrow('enable failed');

    expect(globalThis.fetch).toBe(baseFetch);
    expect(otelInstrumentation.disableCalls).toBe(1);
    expect(traceDisableSpy).toHaveBeenCalledTimes(1);
    expect(contextDisableSpy).toHaveBeenCalledTimes(1);
    expect(propagationDisableSpy).toHaveBeenCalledTimes(1);
    expect(faro.otel).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spanProcessor.forceFlush).toHaveBeenCalledTimes(1);
    expect(spanProcessor.shutdown).not.toHaveBeenCalled();

    await tracingInstrumentation.shutdown();
    expect(spanProcessor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps a supplied processor active across Faro remove and re-add', async () => {
    const exporter = new InMemorySpanExporter();
    const exporterShutdownSpy = jest.spyOn(exporter, 'shutdown');
    const spanProcessor = new SimpleSpanProcessor(exporter);
    const processorShutdownSpy = jest.spyOn(spanProcessor, 'shutdown');
    const { faro, tracingInstrumentation } = addTracingInstrumentation([], spanProcessor);
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    trace.getTracer('processor-reuse').startSpan('before-remove').end();
    await spanProcessor.forceFlush();
    faro.instrumentations.remove(tracingInstrumentation);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processorShutdownSpy).not.toHaveBeenCalled();
    expect(exporterShutdownSpy).not.toHaveBeenCalled();

    const replacementTracingInstrumentation = new TracingInstrumentation({
      instrumentations: [],
      spanProcessor,
    });
    tracingInstrumentations.push(replacementTracingInstrumentation);
    faro.instrumentations.add(replacementTracingInstrumentation);
    trace.getTracer('processor-reuse').startSpan('after-readd').end();
    await spanProcessor.forceFlush();

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['before-remove', 'after-readd']);

    await replacementTracingInstrumentation.shutdown();
    expect(processorShutdownSpy).toHaveBeenCalledTimes(1);
    expect(exporterShutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('re-enables a real fetch instrumentation when a new tracing instance reuses it', async () => {
    const fetchInstrumentation = new FetchInstrumentation({
      ignoreNetworkEvents: true,
      propagateTraceHeaderCorsUrls: [/.*/],
    });
    const enableSpy = jest.spyOn(fetchInstrumentation, 'enable');
    const spanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation } = addTracingInstrumentation(fetchInstrumentation, spanProcessor);
    const patchedFetch = globalThis.fetch;
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    await globalThis.fetch('https://example.com/first');
    expect(spanProcessor.onStart).toHaveBeenCalledTimes(1);
    faro.instrumentations.remove(tracingInstrumentation);

    const replacementTracingInstrumentation = new TracingInstrumentation({
      instrumentations: [fetchInstrumentation],
      spanProcessor,
    });
    tracingInstrumentations.push(replacementTracingInstrumentation);
    faro.instrumentations.add(replacementTracingInstrumentation);
    expect(globalThis.fetch).toBe(patchedFetch);
    expect(enableSpy).toHaveBeenCalledTimes(1);
    await globalThis.fetch('https://example.com/second');

    expect(spanProcessor.onStart).toHaveBeenCalledTimes(2);
  });

  it('reuses default request instrumentations and refreshes transport ignore URLs', async () => {
    const firstCollectorUrl = 'https://collector.example.com/first';
    const secondCollectorUrl = 'https://collector.example.com/second';
    const transport = new MockTransport([firstCollectorUrl]);
    const getIgnoreUrlsSpy = jest.spyOn(transport, 'getIgnoreUrls');
    const setTracerProviderSpy = jest.spyOn(FetchInstrumentation.prototype, 'setTracerProvider');
    const setXhrTracerProviderSpy = jest.spyOn(XMLHttpRequestInstrumentation.prototype, 'setTracerProvider');
    const spanProcessor = createSpanProcessor();
    const faro = initializeFaro(
      mockConfig({
        instrumentations: [],
        transports: [transport],
      })
    ) as FaroWithOtel;
    getInternalFaroMock.mockReturnValue(faro);
    const tracingInstrumentation = new TracingInstrumentation({
      instrumentationOptions: { enableXhrInstrumentation: true },
      spanProcessor,
    });
    tracingInstrumentations.push(tracingInstrumentation);
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    faro.instrumentations.add(tracingInstrumentation);
    const firstFetchInstrumentation = setTracerProviderSpy.mock.instances[0];
    const firstXhrInstrumentation = setXhrTracerProviderSpy.mock.instances[0];
    expect(firstFetchInstrumentation).toBeInstanceOf(FetchInstrumentation);
    expect(firstXhrInstrumentation).toBeInstanceOf(XMLHttpRequestInstrumentation);

    await globalThis.fetch(firstCollectorUrl);
    expect(spanProcessor.onStart).not.toHaveBeenCalled();
    faro.instrumentations.remove(tracingInstrumentation);

    getIgnoreUrlsSpy.mockReturnValue([secondCollectorUrl]);
    faro.instrumentations.add(tracingInstrumentation);
    expect(setTracerProviderSpy.mock.instances).toEqual([firstFetchInstrumentation, firstFetchInstrumentation]);
    expect(setXhrTracerProviderSpy.mock.instances).toEqual([firstXhrInstrumentation, firstXhrInstrumentation]);

    await globalThis.fetch(secondCollectorUrl);
    expect(spanProcessor.onStart).not.toHaveBeenCalled();
    await globalThis.fetch(firstCollectorUrl);
    expect(spanProcessor.onStart).toHaveBeenCalledTimes(1);
  });

  it('does not double-enable an instrumentation that the OpenTelemetry registry re-enables', () => {
    const fetchInstrumentation = new FetchInstrumentation({
      enabled: false,
      ignoreNetworkEvents: true,
      propagateTraceHeaderCorsUrls: [/.*/],
    });
    const enableSpy = jest.spyOn(fetchInstrumentation, 'enable');
    const spanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation } = addTracingInstrumentation(fetchInstrumentation, spanProcessor);

    expect(enableSpy).toHaveBeenCalledTimes(1);
    faro.instrumentations.remove(tracingInstrumentation);

    const replacementTracingInstrumentation = new TracingInstrumentation({
      instrumentations: [fetchInstrumentation],
      spanProcessor,
    });
    tracingInstrumentations.push(replacementTracingInstrumentation);
    faro.instrumentations.add(replacementTracingInstrumentation);

    expect(enableSpy).toHaveBeenCalledTimes(2);
  });

  it('re-enables a supplied context manager when tracing is re-added', async () => {
    const contextManager = new StatefulContextManager();
    const spanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation } = addTracingInstrumentation([], spanProcessor, { contextManager });

    expect(contextManager.enabled).toBe(true);
    expect(contextManager.enableCalls).toBe(1);

    faro.instrumentations.remove(tracingInstrumentation);
    expect(contextManager.enabled).toBe(false);
    expect(contextManager.disableCalls).toBe(1);

    const replacementTracingInstrumentation = new TracingInstrumentation({
      contextManager,
      instrumentations: [],
      spanProcessor,
    });
    tracingInstrumentations.push(replacementTracingInstrumentation);
    faro.instrumentations.add(replacementTracingInstrumentation);
    expect(contextManager.enabled).toBe(true);
    expect(contextManager.enableCalls).toBe(2);
  });

  it('forwards onEnding to a supplied span processor when it is implemented', () => {
    const spanProcessor = createSpanProcessor();
    const { faro } = addTracingInstrumentation([], spanProcessor);
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    trace.getTracer('on-ending').startSpan('span').end();

    expect(spanProcessor.onEnding).toHaveBeenCalledTimes(1);
  });

  it('supports a supplied span processor without onEnding', () => {
    const spanProcessor = createSpanProcessor();
    delete spanProcessor.onEnding;
    const { faro } = addTracingInstrumentation([], spanProcessor);
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    expect(() => trace.getTracer('without-on-ending').startSpan('span').end()).not.toThrow();
  });

  it('shuts down the SDK-owned processor during Faro removal', async () => {
    const exporterShutdownSpy = jest.spyOn(FaroTraceExporter.prototype, 'shutdown');
    const { faro, tracingInstrumentation } = addDefaultTracingInstrumentation();

    faro.instrumentations.remove(tracingInstrumentation);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exporterShutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('reports an SDK-owned provider failure during explicit shutdown', async () => {
    const shutdownError = new Error('exporter shutdown failed');
    jest.spyOn(FaroTraceExporter.prototype, 'shutdown').mockRejectedValue(shutdownError);
    const { faro, tracingInstrumentation } = addDefaultTracingInstrumentation();

    await expect(tracingInstrumentation.shutdown()).rejects.toBe(shutdownError);

    expect(faro.otel).toBeUndefined();
  });

  it('logs an SDK-owned provider failure during Faro removal', async () => {
    const shutdownError = new Error('exporter shutdown failed');
    jest.spyOn(FaroTraceExporter.prototype, 'shutdown').mockRejectedValue(shutdownError);
    const { faro, tracingInstrumentation } = addDefaultTracingInstrumentation();
    const loggerSpy = jest.spyOn(faro.internalLogger, 'error').mockImplementation(() => {});

    faro.instrumentations.remove(tracingInstrumentation);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('@grafana/faro-react-native-tracing'),
      expect.stringContaining('Failed to shut down the OpenTelemetry tracer provider'),
      shutdownError
    );
  });

  it('reinitializes with one active request span', async () => {
    const baseFetch = globalThis.fetch;
    const firstOtelInstrumentation = new FetchTestInstrumentation();
    const firstSpanProcessor = createSpanProcessor();
    const { faro, tracingInstrumentation: firstTracingInstrumentation } = addTracingInstrumentation(
      firstOtelInstrumentation,
      firstSpanProcessor
    );
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });

    await globalThis.fetch('https://example.com/first');
    expect(firstSpanProcessor.onStart).toHaveBeenCalledTimes(1);
    faro.instrumentations.remove(firstTracingInstrumentation);

    const secondOtelInstrumentation = new FetchTestInstrumentation();
    const secondSpanProcessor = createSpanProcessor();
    const secondTracingInstrumentation = new TracingInstrumentation({
      instrumentations: [secondOtelInstrumentation],
      spanProcessor: secondSpanProcessor,
    });
    tracingInstrumentations.push(secondTracingInstrumentation);
    faro.instrumentations.add(secondTracingInstrumentation);
    await globalThis.fetch('https://example.com/second');

    expect(firstSpanProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(secondSpanProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(firstOtelInstrumentation.requestCount).toBe(1);
    expect(secondOtelInstrumentation.requestCount).toBe(1);

    await secondTracingInstrumentation.shutdown();
    await globalThis.fetch('https://example.com/after-shutdown');
    expect(firstSpanProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(secondSpanProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toBe(baseFetch);
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });
});
