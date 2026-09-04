import { context, propagation, trace } from '@opentelemetry/api';
import type { Attributes, Context, ContextManager } from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, BasicTracerProvider as ReactNativeTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { BasicTracerProvider, ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';

import { BaseInstrumentation, getInternalFaroFromGlobalObject, VERSION } from '@grafana/faro-core';
import type { Faro, OTELApi, Transport } from '@grafana/faro-core';

import { FaroTraceExporter } from './exporters/faroTraceExporter';
import { getReactNativeDevServerIgnoreUrls } from './instrumentations/devServerIgnoreUrls';
import {
  getDefaultOTELInstrumentations,
  updateDefaultOTELInstrumentations,
} from './instrumentations/getDefaultOTELInstrumentations';
import { FaroMetaAttributesSpanProcessor } from './processors/faroMetaAttributesSpanProcessor';
import { HttpRequestMonitorSpanProcessor } from './processors/httpRequestMonitorSpanProcessor';
import {
  ATTR_APP_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_DEVICE_BRAND,
  ATTR_DEVICE_LOCALE,
  ATTR_DEVICE_MODEL,
  ATTR_DEVICE_OS_VERSION,
  ATTR_DEVICE_PLATFORM,
  ATTR_PROCESS_RUNTIME_NAME,
  ATTR_PROCESS_RUNTIME_VERSION,
  ATTR_SERVICE_NAMESPACE,
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from './semconv';
import type { TracingInstrumentationOptions } from './types';
import { getSamplingDecision } from './utils/sampler';

// Import React Native TracerProvider
// Note: We use the base provider since React Native doesn't have a specific one

type FaroWithOtel = Faro & { otel?: unknown };
const detachedInstrumentations = new WeakSet<Instrumentation>();

/**
 * Keeps a caller-supplied processor reusable across Faro remove/add cycles.
 * Explicit TracingInstrumentation.shutdown() remains responsible for the
 * processor's terminal shutdown.
 */
class BorrowedSpanProcessor implements SpanProcessor {
  constructor(private readonly processor: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.processor.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.processor.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    this.processor.onEnd(span);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

interface TracingRegistration {
  contextManager?: ContextManager;
  faro?: FaroWithOtel;
  faroOtel?: OTELApi;
  instrumentations: Instrumentation[];
  ownsContextManager: boolean;
  ownsContextManagerInstance: boolean;
  ownsPropagator: boolean;
  ownsTracerProvider: boolean;
  previousFaroOtel?: unknown;
  provider: BasicTracerProvider;
  shutdownPromise?: Promise<void>;
  unregisterInstrumentations?: VoidFunction;
}

/**
 * TracingInstrumentation for React Native
 *
 * Enables distributed tracing with OpenTelemetry for React Native applications.
 *
 * IMPORTANT: Infinite loop prevention
 * - Uses internalLogger for debugging instead of console
 * - Collector URLs are added to ignoreUrls in HTTP instrumentation
 * - BatchSpanProcessor delays span export to avoid blocking
 * - No console logging during trace export
 *
 * Example usage:
 * ```ts
 * import { initializeFaro } from '@grafana/faro-react-native';
 * import { TracingInstrumentation } from '@grafana/faro-react-native-tracing';
 *
 * initializeFaro({
 *   // ... other config
 *   instrumentations: [
 *     new TracingInstrumentation({
 *       propagateTraceHeaderCorsUrls: [/https:\\/\\/my-api\\.com/],
 *     }),
 *   ],
 * });
 * ```
 */
export class TracingInstrumentation extends BaseInstrumentation {
  name = '@grafana/faro-react-native-tracing';
  version = VERSION;

  static SCHEDULED_BATCH_DELAY_MS = 1000;

  private activeRegistration?: TracingRegistration;
  private defaultInstrumentations?: Instrumentation[];
  private pendingShutdowns = new Set<Promise<void>>();
  private suppliedSpanProcessorShutdown?: Promise<void>;

  constructor(private options: TracingInstrumentationOptions = {}) {
    super();
  }

  initialize(): void {
    this.destroy();

    const options = this.options;
    const attributes: Attributes = {};

    // App attributes
    if (this.config.app.name) {
      attributes[ATTR_SERVICE_NAME] = this.config.app.name;
    }

    if (this.config.app.namespace) {
      attributes[ATTR_SERVICE_NAMESPACE] = this.config.app.namespace;
    }

    if (this.config.app.version) {
      attributes[ATTR_SERVICE_VERSION] = this.config.app.version;
      attributes[ATTR_APP_VERSION] = this.config.app.version;
    }

    if (this.config.app.environment) {
      attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = this.config.app.environment;

      /**
       * @deprecated will be removed in the future and has been replaced by ATTR_DEPLOYMENT_ENVIRONMENT_NAME (deployment.environment.name)
       * We need to keep this for compatibility with some internal services for now.
       */
      attributes[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT] = this.config.app.environment;
    }

    // Device/Platform attributes from React Native
    // Note: metas.value contains all meta providers, we need to check if device meta exists
    const allMetas = this.metas.value as Record<string, unknown>;
    const deviceMeta = allMetas['device'] as
      | {
          model?: string;
          brand?: string;
          osName?: string;
          osVersion?: string;
          locale?: string;
        }
      | undefined;

    if (deviceMeta?.model) {
      attributes[ATTR_DEVICE_MODEL] = deviceMeta.model;
    }

    if (deviceMeta?.brand) {
      attributes[ATTR_DEVICE_BRAND] = deviceMeta.brand;
    }

    if (deviceMeta?.osName) {
      attributes[ATTR_DEVICE_PLATFORM] = deviceMeta.osName;
    }

    if (deviceMeta?.osVersion) {
      attributes[ATTR_DEVICE_OS_VERSION] = deviceMeta.osVersion;
    }

    if (deviceMeta?.locale) {
      attributes[ATTR_DEVICE_LOCALE] = deviceMeta.locale;
    }

    attributes[ATTR_PROCESS_RUNTIME_NAME] = 'react-native';
    attributes[ATTR_PROCESS_RUNTIME_VERSION] = deviceMeta?.osVersion ?? 'unknown';

    attributes[ATTR_TELEMETRY_DISTRO_NAME] = 'faro-react-native-sdk';
    attributes[ATTR_TELEMETRY_DISTRO_VERSION] = VERSION;

    // Merge with user-provided attributes
    Object.assign(attributes, options.resourceAttributes);

    const resource = defaultResource().merge(resourceFromAttributes(attributes));

    // Create tracer provider with span processors
    const provider = new ReactNativeTracerProvider({
      resource,
      sampler: {
        shouldSample: () => {
          return {
            decision: getSamplingDecision(this.api.getSession()),
          };
        },
      },
      spanProcessors: [
        (options.spanProcessor && new BorrowedSpanProcessor(options.spanProcessor)) ??
          new HttpRequestMonitorSpanProcessor(
            new FaroMetaAttributesSpanProcessor(
              new BatchSpanProcessor(new FaroTraceExporter({ api: this.api }), {
                scheduledDelayMillis: TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS,
                maxExportBatchSize: 30,
              }),
              this.metas
            )
          ),
      ],
    });

    const registration: TracingRegistration = {
      instrumentations: [],
      ownsContextManager: false,
      ownsContextManagerInstance: false,
      ownsPropagator: false,
      ownsTracerProvider: false,
      provider,
    };
    this.activeRegistration = registration;

    try {
      // Register the provider as the global tracer provider
      // This is CRITICAL for the tracer to generate real trace IDs instead of all zeros
      if (!trace.setGlobalTracerProvider(provider)) {
        throw new Error(
          'Unable to register the Faro OpenTelemetry tracer provider. Remove the existing global tracer provider before initializing Faro tracing.'
        );
      }
      registration.ownsTracerProvider = true;

      // Register a global ContextManager. Without one, OTel falls back to the NoopContextManager,
      // which always returns ROOT_CONTEXT — so when `@opentelemetry/instrumentation-fetch` does
      // `context.with(setSpan(active(), createdSpan), () => _addHeaders(...))` the span set on the
      // wrapped context is invisible inside `_addHeaders` and `propagation.inject` writes nothing.
      // `StackContextManager` is pure JS (no DOM/Zone deps) and works in React Native.
      const contextManager = (options.contextManager ?? new StackContextManager()).enable();
      registration.contextManager = contextManager;
      registration.ownsContextManagerInstance = options.contextManager == null;
      registration.ownsContextManager = context.setGlobalContextManager(contextManager);

      // Register the global text-map propagator. Without this, OTel falls back to a
      // NoopTextMapPropagator and `propagation.inject(...)` becomes a no-op, meaning
      // `traceparent` / `tracestate` (and `baggage`) headers are never written on the
      // outbound fetch/XHR — so the backend receives no context and starts a new trace.
      registration.ownsPropagator = propagation.setGlobalPropagator(
        options.propagator ??
          new CompositePropagator({
            propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
          })
      );

      const {
        enableFetchInstrumentation,
        enableXhrInstrumentation,
        propagateTraceHeaderCorsUrls,
        fetchInstrumentationOptions,
        xhrInstrumentationOptions,
      } = this.options.instrumentationOptions ?? {};

      // Get ignore URLs from transports to prevent infinite loops
      const ignoreUrls = this.getIgnoreUrls();

      const defaultInstrumentationOptions = {
        ignoreUrls,
        enableFetchInstrumentation,
        enableXhrInstrumentation,
        propagateTraceHeaderCorsUrls,
        fetchInstrumentationOptions,
        xhrInstrumentationOptions,
      };

      if (options.instrumentations) {
        registration.instrumentations = options.instrumentations.flat();
      } else if (this.defaultInstrumentations) {
        updateDefaultOTELInstrumentations(this.defaultInstrumentations, defaultInstrumentationOptions);
        registration.instrumentations = this.defaultInstrumentations;
      } else {
        this.defaultInstrumentations = getDefaultOTELInstrumentations(defaultInstrumentationOptions).flat();
        registration.instrumentations = this.defaultInstrumentations;
      }

      const instrumentationsNeedingExplicitEnable = registration.instrumentations.filter(
        (instrumentation) =>
          detachedInstrumentations.has(instrumentation) && instrumentation.getConfig().enabled === true
      );
      registration.unregisterInstrumentations = registerInstrumentations({
        instrumentations: registration.instrumentations,
      });
      registration.instrumentations.forEach((instrumentation) => {
        detachedInstrumentations.delete(instrumentation);
      });
      instrumentationsNeedingExplicitEnable.forEach((instrumentation) => instrumentation.enable());

      // Expose OTEL API on the global Faro instance for manual span creation
      // This allows users to access trace and context APIs via faro.otel
      const globalFaroInstance = getInternalFaroFromGlobalObject() as FaroWithOtel | undefined;
      if (globalFaroInstance) {
        const faroOtel: OTELApi = { trace, context };
        registration.faro = globalFaroInstance;
        registration.faroOtel = faroOtel;
        registration.previousFaroOtel = globalFaroInstance.otel;
        globalFaroInstance.otel = faroOtel;
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Get ignore URLs from all transports to avoid tracing collector requests
   * CRITICAL: This prevents infinite loops where trace exports trigger more traces
   */
  private getIgnoreUrls(): Array<string | RegExp> {
    // Get URLs from transports' getIgnoreUrls() method
    const transportUrls = this.transports.transports.flatMap((transport: Transport) => {
      return transport.getIgnoreUrls();
    });

    // Create regex patterns that match both with and without trailing slashes
    // This is critical because fetch() might add trailing slashes
    const regexPatterns = transportUrls.map((url) => {
      if (typeof url === 'string') {
        // Escape special regex characters and make trailing slash optional
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^${escapedUrl}/?$`);
      }
      return url;
    });

    // Return dev-server, original transport URLs, and regex patterns for maximum coverage.
    return [...getReactNativeDevServerIgnoreUrls(), ...transportUrls, ...regexPatterns];
  }

  private detachRegistration(): TracingRegistration | undefined {
    const registration = this.activeRegistration;
    if (!registration) {
      return undefined;
    }
    this.activeRegistration = undefined;
    registration.instrumentations.forEach((instrumentation) => detachedInstrumentations.add(instrumentation));

    let unregistered = false;
    if (registration.unregisterInstrumentations) {
      try {
        registration.unregisterInstrumentations();
        unregistered = true;
      } catch (error) {
        this.logCleanupError('unregister OpenTelemetry instrumentations', error);
      }
    }
    if (!unregistered) {
      registration.instrumentations.forEach((instrumentation) => {
        this.runCleanup(`disable ${instrumentation.instrumentationName}`, () => instrumentation.disable());
      });
    }

    const { faro, faroOtel } = registration;
    if (faro && faroOtel && faro.otel === faroOtel) {
      this.runCleanup('restore faro.otel', () => {
        if (registration.previousFaroOtel === undefined) {
          delete faro.otel;
        } else {
          faro.otel = registration.previousFaroOtel;
        }
      });
    }

    if (registration.ownsPropagator) {
      this.runCleanup('clear the OpenTelemetry propagator', () => propagation.disable());
    }
    if (registration.ownsContextManager) {
      this.runCleanup('clear the OpenTelemetry context manager', () => context.disable());
    } else if (registration.ownsContextManagerInstance && registration.contextManager) {
      this.runCleanup('disable the unused OpenTelemetry context manager', () => registration.contextManager?.disable());
    }
    if (registration.ownsTracerProvider) {
      this.runCleanup('clear the OpenTelemetry tracer provider', () => trace.disable());
    }

    return registration;
  }

  private runCleanup(action: string, cleanup: VoidFunction): void {
    try {
      cleanup();
    } catch (error) {
      this.logCleanupError(action, error);
    }
  }

  private logCleanupError(action: string, error: unknown): void {
    try {
      this.logError(`Failed to ${action}:`, error);
    } catch (_loggingError) {
      // Cleanup must not fail because a custom logger threw.
    }
  }

  private startProviderShutdown(registration: TracingRegistration): Promise<void> {
    if (!registration.shutdownPromise) {
      const shutdownPromise = Promise.resolve()
        .then(() => registration.provider.forceFlush())
        .catch((error) => {
          this.logCleanupError('flush the OpenTelemetry tracer provider', error);
        })
        .then(() => registration.provider.shutdown());
      registration.shutdownPromise = shutdownPromise;
      this.pendingShutdowns.add(shutdownPromise);
      void shutdownPromise.then(
        () => this.pendingShutdowns.delete(shutdownPromise),
        () => this.pendingShutdowns.delete(shutdownPromise)
      );
    }
    return registration.shutdownPromise;
  }

  private startSuppliedSpanProcessorShutdown(): Promise<void> | undefined {
    const spanProcessor = this.options.spanProcessor;
    if (!spanProcessor) {
      return undefined;
    }
    if (!this.suppliedSpanProcessorShutdown) {
      try {
        this.suppliedSpanProcessorShutdown = spanProcessor.shutdown();
      } catch (error) {
        this.suppliedSpanProcessorShutdown = Promise.reject(error);
      }
    }
    return this.suppliedSpanProcessorShutdown;
  }

  /** Detach request instrumentations and wait for the tracer provider to flush. */
  async shutdown(): Promise<void> {
    const pendingShutdowns = Array.from(this.pendingShutdowns);
    const registration = this.detachRegistration();
    if (registration) {
      pendingShutdowns.push(this.startProviderShutdown(registration));
    }

    let firstError: unknown;
    let shutdownFailed = false;
    for (const shutdownPromise of pendingShutdowns) {
      try {
        await shutdownPromise;
      } catch (error) {
        if (!shutdownFailed) {
          firstError = error;
          shutdownFailed = true;
        }
      }
    }
    const spanProcessorShutdown = this.startSuppliedSpanProcessorShutdown();
    if (spanProcessorShutdown) {
      try {
        await spanProcessorShutdown;
      } catch (error) {
        if (!shutdownFailed) {
          firstError = error;
          shutdownFailed = true;
        }
      }
    }
    if (shutdownFailed) {
      throw firstError;
    }
  }

  /** Detach synchronously when Faro removes this instrumentation. */
  destroy(): void {
    const registration = this.detachRegistration();
    if (!registration) {
      return;
    }
    void this.startProviderShutdown(registration).then(undefined, (error) => {
      this.logCleanupError('shut down the OpenTelemetry tracer provider', error);
    });
  }
}
