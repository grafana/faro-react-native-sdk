import type { Instrumentation } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';

import type { DefaultInstrumentationsOptions, InstrumentationOption } from '../types';

import {
  captureFetchUserAction,
  fetchCustomAttributeFunctionWithDefaults,
  xhrCustomAttributeFunctionWithDefaults,
} from './instrumentationUtils';

/**
 * Get default OTEL instrumentations for React Native
 *
 * This function creates the default OpenTelemetry instrumentations for React Native:
 * - FetchInstrumentation: Traces fetch() API calls
 * - XMLHttpRequestInstrumentation: Optional for apps that use XHR/axios directly
 *
 * IMPORTANT: Infinite loop prevention
 * - ignoreUrls is used to exclude Faro collector URLs
 * - ignoreNetworkEvents is true to avoid duplicate events
 * - No console logging during instrumentation
 *
 * @param options - Configuration options
 * @returns Array of OTEL instrumentations
 */
export function getDefaultOTELInstrumentations(options: DefaultInstrumentationsOptions = {}): InstrumentationOption[] {
  const { enableFetchInstrumentation, enableXhrInstrumentation, fetchConfig, xhrConfig } =
    resolveDefaultInstrumentationOptions(options);

  const instrumentations: InstrumentationOption[] = [];

  if (enableFetchInstrumentation) {
    instrumentations.push(new FetchInstrumentation(fetchConfig));
  }

  if (enableXhrInstrumentation) {
    instrumentations.push(new XMLHttpRequestInstrumentation(xhrConfig));
  }

  return instrumentations;
}

export function updateDefaultOTELInstrumentations(
  instrumentations: Instrumentation[],
  options: DefaultInstrumentationsOptions = {}
): void {
  const { fetchConfig, xhrConfig } = resolveDefaultInstrumentationOptions(options);

  instrumentations.forEach((instrumentation) => {
    if (instrumentation instanceof FetchInstrumentation) {
      instrumentation.setConfig(fetchConfig);
    } else if (instrumentation instanceof XMLHttpRequestInstrumentation) {
      instrumentation.setConfig(xhrConfig);
    }
  });
}

function resolveDefaultInstrumentationOptions(options: DefaultInstrumentationsOptions) {
  const {
    enableFetchInstrumentation = true,
    enableXhrInstrumentation = false,
    fetchInstrumentationOptions,
    xhrInstrumentationOptions,
    ...sharedOptions
  } = options;

  return {
    enableFetchInstrumentation,
    enableXhrInstrumentation,
    fetchConfig: createFetchInstrumentationOptions(fetchInstrumentationOptions, sharedOptions),
    xhrConfig: createXhrInstrumentationOptions(xhrInstrumentationOptions, sharedOptions),
  };
}

function createFetchInstrumentationOptions(
  fetchInstrumentationOptions: DefaultInstrumentationsOptions['fetchInstrumentationOptions'],
  sharedOptions: Record<string, unknown>
) {
  return {
    ...sharedOptions,
    // Ignore network performance events to avoid duplicates
    ignoreNetworkEvents: true,
    // Keep this here to overwrite the defaults above if provided by the users
    ...fetchInstrumentationOptions,
    semconvStabilityOptIn: fetchInstrumentationOptions?.semconvStabilityOptIn ?? 'http',
    // Always keep this function
    applyCustomAttributesOnSpan: fetchCustomAttributeFunctionWithDefaults(
      fetchInstrumentationOptions?.applyCustomAttributesOnSpan
    ),
    // Also supports callers using a custom processor without the RN request monitor.
    requestHook: captureFetchUserAction,
  };
}

function createXhrInstrumentationOptions(
  xhrInstrumentationOptions: DefaultInstrumentationsOptions['xhrInstrumentationOptions'],
  sharedOptions: Record<string, unknown>
) {
  return {
    ...sharedOptions,
    ignoreNetworkEvents: true,
    ...xhrInstrumentationOptions,
    applyCustomAttributesOnSpan: xhrCustomAttributeFunctionWithDefaults(
      xhrInstrumentationOptions?.applyCustomAttributesOnSpan
    ),
  };
}
