import { type ExceptionEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { FetchTransport } from '../../transports/fetch';

import { AndroidCrashReportingInstrumentation } from './android/AndroidCrashReportingInstrumentation';
import { CrashReportingInstrumentation } from './index';
import type { CrashReport } from './types';

const CRASH_TRACE = [
  "ABI: 'arm64'",
  'backtrace:',
  '      #00 pc 0000000000001234  /data/app/lib/arm64-v8a/libappmodules.so (nativeCrash+8)',
].join('\n');

type NativeCrashModule = {
  acknowledgeCrashReports: ReturnType<typeof jest.fn>;
  getPendingCrashReports: ReturnType<typeof jest.fn>;
  recordCrashSessionContext: ReturnType<typeof jest.fn>;
};

type TestableAndroidCrashInstrumentation = {
  prepareCrashReporting: (nativeModule: NativeCrashModule) => void;
  processCrashReports: (nativeModule: NativeCrashModule) => Promise<void>;
};

function createCrashReport(overrides: Partial<CrashReport> = {}): CrashReport {
  return {
    reportId: 'report-a',
    reason: 'CRASH_NATIVE',
    sessionId: 'session-a',
    timestamp: Date.now() - 1000,
    trace: CRASH_TRACE,
    ...overrides,
  };
}

function createNativeCrashModule(reports: Array<CrashReport | string>): NativeCrashModule {
  return {
    acknowledgeCrashReports: jest.fn().mockResolvedValue(undefined),
    getPendingCrashReports: jest
      .fn()
      .mockResolvedValue(reports.map((report) => (typeof report === 'string' ? report : JSON.stringify(report)))),
    recordCrashSessionContext: jest.fn().mockReturnValue(true),
  };
}

function setupAndroidReplay(
  reports: Array<CrashReport | string>,
  beforeSend?: (item: TransportItem) => TransportItem | null
) {
  const transport = new FetchTransport({ url: 'http://example.com/collect' });
  const instrumentation = new AndroidCrashReportingInstrumentation({ enabled: false });
  const faro = initializeFaro(
    mockConfig({
      transports: [transport],
      instrumentations: [instrumentation],
      ...(beforeSend ? { beforeSend } : {}),
    })
  );
  faro.api.setSession({ id: 'session-b' });

  const nativeModule = createNativeCrashModule(reports);
  const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({
    outcome: 'accepted',
    status: 202,
  });
  const testable = instrumentation as unknown as TestableAndroidCrashInstrumentation;
  testable.prepareCrashReporting(nativeModule);

  return { faro, instrumentation, nativeModule, sendSpy, testable };
}

describe('CrashReportingInstrumentation', () => {
  const androidInstrumentations: AndroidCrashReportingInstrumentation[] = [];

  beforeEach(() => {
    jest.restoreAllMocks();
    delete (global as any).faro;
  });

  afterEach(() => {
    androidInstrumentations.splice(0).forEach((instrumentation) => instrumentation.unpatch());
    delete (global as any).faro;
  });

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
      signal: 'SIGSEGV (11)',
      timestamp: 1710000000000,
      trace: CRASH_TRACE,
    });

    expect(transport.items).toHaveLength(1);
    const item = transport.items[0] as TransportItem<ExceptionEvent>;
    expect(item.payload.type).toBe('crash');
    expect(item.payload.fatal).toBe(true);
    expect(item.payload.context?.mechanism).toBe('crash');
    expect(item.payload.context?.signal).toBe('SIGSEGV (11)');
    expect(item.payload.context?.trace).toContain('#00 pc');
  });

  it('replays a recovered crash with its original session and timestamp without changing the live session', async () => {
    const crashTimestamp = Date.now() - 1000;
    const setup = setupAndroidReplay([
      createCrashReport({
        appVersion: '1.2.3',
        reportId: 'report-a',
        sessionId: 'session-a',
        timestamp: crashTimestamp,
      }),
    ]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(1);
    const item = setup.sendSpy.mock.calls[0]?.[0]?.[0] as TransportItem<ExceptionEvent>;
    expect(item.meta.session?.id).toBe('session-a');
    expect(item.meta.app?.version).toBe('1.2.3');
    expect(item.payload.timestamp).toBe(new Date(crashTimestamp).toISOString());
    expect(item.payload.fatal).toBe(true);
    expect(setup.faro.metas.value.session?.id).toBe('session-b');
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['report-a']);
    expect(setup.nativeModule.recordCrashSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-b' })
    );
  });

  it('persists later live-session changes without mutating a recovered crash', async () => {
    const setup = setupAndroidReplay([createCrashReport()]);
    androidInstrumentations.push(setup.instrumentation);

    setup.faro.api.setSession({ id: 'session-c' });
    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.nativeModule.recordCrashSessionContext.mock.calls.map(([context]) => context.sessionId)).toEqual([
      'session-b',
      'session-c',
    ]);
    const sentItem = setup.sendSpy.mock.calls[0]?.[0]?.[0];
    expect(sentItem?.meta.session?.id).toBe('session-a');
    expect(setup.faro.metas.value.session?.id).toBe('session-c');
  });

  it.each(['failed', 'rejected', 'skipped'] as const)(
    'leaves the report pending when delivery is %s',
    async (outcome) => {
      const setup = setupAndroidReplay([createCrashReport()]);
      androidInstrumentations.push(setup.instrumentation);
      setup.sendSpy.mockResolvedValue(
        outcome === 'rejected'
          ? { outcome, status: 500 }
          : {
              outcome,
            }
      );

      await setup.testable.processCrashReports(setup.nativeModule);

      expect(setup.sendSpy).toHaveBeenCalledTimes(1);
      expect(setup.nativeModule.acknowledgeCrashReports).not.toHaveBeenCalled();
    }
  );

  it('replays multiple historical crashes under their own sessions and de-duplicates report IDs', async () => {
    const setup = setupAndroidReplay([
      createCrashReport({ reportId: 'report-a', sessionId: 'session-a', timestamp: Date.now() - 2000 }),
      createCrashReport({ reportId: 'report-b', sessionId: 'session-b-old', timestamp: Date.now() - 1000 }),
      createCrashReport({ reportId: 'report-a', sessionId: 'session-a', timestamp: Date.now() - 2000 }),
    ]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(2);
    expect(setup.sendSpy.mock.calls.map(([items]) => items[0]?.meta.session?.id)).toEqual([
      'session-a',
      'session-b-old',
    ]);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledTimes(2);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenNthCalledWith(1, ['report-a']);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenNthCalledWith(2, ['report-b']);
    expect(setup.faro.metas.value.session?.id).toBe('session-b');
  });

  it('accepts the seven-day boundary and acknowledges an older report without sending it', async () => {
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const setup = setupAndroidReplay([
      createCrashReport({ reportId: 'boundary', timestamp: now - sevenDaysMs }),
      createCrashReport({ reportId: 'expired', timestamp: now - sevenDaysMs - 1 }),
    ]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(1);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['boundary']);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['expired']);
  });

  it('leaves a report pending when the original session context is missing', async () => {
    const setup = setupAndroidReplay([createCrashReport({ sessionId: undefined })]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).not.toHaveBeenCalled();
    expect(setup.faro.metas.value.session?.id).toBe('session-b');
  });

  it('acknowledges only the malformed report when its stable ID is available', async () => {
    const setup = setupAndroidReplay([
      createCrashReport({ reportId: 'malformed', timestamp: Number.NaN }),
      createCrashReport({ reportId: 'valid' }),
    ]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(1);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['malformed']);
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['valid']);
  });

  it('acknowledges a platform-filtered report without sending it repeatedly', async () => {
    const setup = setupAndroidReplay([
      createCrashReport({
        description: 'Input dispatching timed out',
        reportId: 'anr-report',
      }),
    ]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['anr-report']);
  });

  it('honors beforeSend filtering and acknowledges the handled report', async () => {
    const beforeSend = jest.fn(() => null);
    const setup = setupAndroidReplay([createCrashReport()], beforeSend);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(beforeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          session: expect.objectContaining({ id: 'session-a' }),
        }),
      })
    );
    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['report-a']);
  });

  it('treats an invalid undefined beforeSend result as filtered', async () => {
    const beforeSend = jest.fn(() => undefined) as unknown as (item: TransportItem) => TransportItem | null;
    const setup = setupAndroidReplay([createCrashReport()], beforeSend);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['report-a']);
  });
});
