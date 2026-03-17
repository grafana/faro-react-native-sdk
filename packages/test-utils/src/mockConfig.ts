import { type Config, defaultBatchingConfig } from '@grafana/faro-core';
import { defaultInternalLoggerLevel } from '@grafana/faro-core';

import { mockStacktraceParser } from './mockStacktraceParser';

/** Session tracking overrides may include RN-specific props like `sampling` (Flutter-style). */
type SessionTrackingOverrides = Partial<NonNullable<Config['sessionTracking']>> & Record<string, unknown>;

export function mockConfig(
  overrides: Partial<Omit<Config, 'sessionTracking'>> & {
    sessionTracking?: SessionTrackingOverrides;
  } = {}
): Config {
  return {
    app: {
      name: 'test',
      version: '1.0.0',
    },
    batching: {
      enabled: false,
    },
    dedupe: true,
    globalObjectKey: 'faro',
    internalLoggerLevel: defaultInternalLoggerLevel,
    instrumentations: [],
    isolate: true,
    metas: [],
    parseStacktrace: mockStacktraceParser,
    paused: false,
    preventGlobalExposure: true,
    transports: [],
    unpatchedConsole: console,
    sessionTracking: {
      ...defaultBatchingConfig,
    },
    ...overrides,
  };
}
