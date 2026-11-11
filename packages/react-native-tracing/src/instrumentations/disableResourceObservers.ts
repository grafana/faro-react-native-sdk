import { hrTime } from '@opentelemetry/core';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';

interface ResourceObserverProblem {
  instrumentationName: string;
  hook: string;
  reason: 'missing' | 'write-failed';
}

const prepareSpanData = (spanUrl: string) => ({ entries: [], startTime: hrTime(), spanUrl });
const addResourceObserver = () => {};

/**
 * RN resource entries lack OTel's initiatorType values. Replace only the unused
 * observer hooks on Faro's instances, including duplicate OTel copies. Keep the
 * overrides across disable/enable; tests guard these private upstream contracts.
 */
export function disableResourceObservers(instrumentation: Instrumentation): ResourceObserverProblem[] {
  const name = instrumentation.instrumentationName;
  let hook: string;
  let replacement: ((spanUrl: string) => unknown) | (() => void);
  if (instrumentation instanceof FetchInstrumentation || name === '@opentelemetry/instrumentation-fetch') {
    hook = '_prepareSpanData';
    replacement = prepareSpanData;
  } else if (
    instrumentation instanceof XMLHttpRequestInstrumentation ||
    name === '@opentelemetry/instrumentation-xml-http-request'
  ) {
    hook = '_addResourceObserver';
    replacement = addResourceObserver;
  } else {
    return [];
  }

  const target = instrumentation as unknown as Record<string, unknown>;
  try {
    if (typeof target[hook] !== 'function') {
      return [{ instrumentationName: name, hook, reason: 'missing' }];
    }
    if (!Object.prototype.hasOwnProperty.call(target, hook) || target[hook] !== replacement) {
      Object.defineProperty(target, hook, { value: replacement, writable: true, configurable: true });
    }
    return [];
  } catch {
    return [{ instrumentationName: name, hook, reason: 'write-failed' }];
  }
}
