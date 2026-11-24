import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';

import { initializeFaro, TransportItemType } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { TracingInstrumentation } from './instrumentation';

// Keep the real Faro and OpenTelemetry APIs while avoiding React Native's native modules.
jest.mock('@grafana/faro-react-native', () => ({
  FARO_REACT_NATIVE_NPM_VERSION: '1.2.3',
}));

describe('TracingInstrumentation trace context', () => {
  let tracingInstrumentation: TracingInstrumentation;
  let transport: MockTransport;

  beforeEach(() => {
    tracingInstrumentation = new TracingInstrumentation({ instrumentations: [] });
    transport = new MockTransport();
  });

  afterEach(async () => {
    await tracingInstrumentation.shutdown();
  });

  function initialize() {
    return initializeFaro(mockConfig({ instrumentations: [tracingInstrumentation], transports: [transport] }));
  }

  it('includes the active span IDs in a Faro event', () => {
    const faro = initialize();
    faro.api.setSession({ id: 'sampled-session', attributes: { isSampled: 'true' } });
    const spanContext = trace.getTracer('test').startActiveSpan('checkout', (span) => {
      faro.api.pushEvent('checkout_completed');
      span.end();
      return span.spanContext();
    });

    expect(isSpanContextValid(spanContext)).toBe(true);
    expect(transport.items).toContainEqual(
      expect.objectContaining({
        type: TransportItemType.EVENT,
        payload: expect.objectContaining({
          name: 'checkout_completed',
          trace: {
            trace_id: spanContext.traceId,
            span_id: spanContext.spanId,
          },
        }),
      })
    );
  });

  it('exposes the OpenTelemetry APIs on the Faro instance', () => {
    const faro = initialize();
    const otel = faro.api.getOTEL();

    expect(otel?.trace).toBe(trace);
    expect(otel?.context).toBe(context);
  });

  it('stops correlating events after removal even inside a still-active external context', () => {
    expect(context.setGlobalContextManager(new StackContextManager().enable())).toBe(true);

    try {
      const faro = initialize();
      trace.getTracer('test').startActiveSpan('checkout', (span) => {
        faro.instrumentations.remove(tracingInstrumentation);

        expect(trace.getSpanContext(context.active())).toEqual(span.spanContext());
        faro.api.pushEvent('after_tracing_removal');
        span.end();
      });

      expect(transport.items).toContainEqual(
        expect.objectContaining({
          type: TransportItemType.EVENT,
          payload: expect.objectContaining({ name: 'after_tracing_removal', trace: undefined }),
        })
      );
    } finally {
      context.disable();
    }
  });

  it('restores a Faro API registration that predates tracing', () => {
    const faro = initializeFaro(mockConfig({ transports: [transport] }));
    const previousContext = new Proxy(context, {});
    faro.api.initOTEL(trace, previousContext);

    faro.instrumentations.add(tracingInstrumentation);
    expect(faro.api.getOTEL()?.context).toBe(context);
    faro.instrumentations.remove(tracingInstrumentation);

    expect(faro.api.getOTEL()?.context).toBe(previousContext);
  });

  it('leaves a newer Faro API registration in place on removal', () => {
    const faro = initialize();
    faro.api.initOTEL(trace, context);
    const newerRegistration = faro.api.getOTEL();

    faro.instrumentations.remove(tracingInstrumentation);

    expect(faro.api.getOTEL()).toBe(newerRegistration);
  });
});
