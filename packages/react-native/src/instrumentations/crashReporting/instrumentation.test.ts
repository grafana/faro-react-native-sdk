import { type ExceptionEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { CrashReportingInstrumentation } from './instrumentation';
import type { CrashReport } from './types';

describe('CrashReportingInstrumentation', () => {
  it('should report native crashes as fatal exceptions', () => {
    const transport = new MockTransport();
    const instrumentation = new CrashReportingInstrumentation({ enabled: false });

    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [instrumentation],
      })
    );

    (
      instrumentation as unknown as {
        sendCrashReport: (crash: CrashReport) => void;
      }
    ).sendCrashReport({
      reason: 'CRASH_NATIVE',
      signal: 'SIGSEGV',
      timestamp: 1710000000000,
      trace: 'native stack',
    });

    expect(transport.items).toHaveLength(1);
    const item = transport.items[0] as TransportItem<ExceptionEvent>;
    expect(item.payload.type).toBe('crash');
    expect(item.payload.fatal).toBe(true);
    expect(item.payload.context?.mechanism).toBe('crash');
    expect(item.payload.context?.signal).toBe('SIGSEGV');
  });
});
