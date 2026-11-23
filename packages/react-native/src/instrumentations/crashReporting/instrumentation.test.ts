import { type ExceptionEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { SamplingRate } from '../../config/sampling';
import {
  DYNAMIC_DEVICE_STATE_TTL_MS,
  DynamicDeviceStateProvider,
  getDynamicDeviceStateMeta,
} from '../../metas/dynamicDeviceState';
import { FetchTransport } from '../../transports/fetch';
import { createUserPersistence, setUserPersistence } from '../../userPersistence';
import { SessionInstrumentation } from '../session';
import { VolatileSessionsManager } from '../session/sessionManager/VolatileSessionManager';

import { AndroidCrashReportingInstrumentation } from './android/AndroidCrashReportingInstrumentation';
import { CrashReportingInstrumentation } from './index';
import { IosCrashReportingInstrumentation } from './ios/IosCrashReportingInstrumentation';
import type { CrashReport } from './types';

const CRASH_TRACE = [
  "ABI: 'arm64'",
  'backtrace:',
  '      #00 pc 0000000000001234  /data/app/lib/arm64-v8a/libappmodules.so (nativeCrash+8)',
].join('\n');

type NativeCrashModule = {
  acknowledgeCrashReports: ReturnType<typeof jest.fn>;
  getCrashReport?: ReturnType<typeof jest.fn>;
  getPendingCrashReports: ReturnType<typeof jest.fn>;
  recordCrashSessionContext: ReturnType<typeof jest.fn>;
};

type TestableAndroidCrashInstrumentation = {
  prepareCrashReporting: (nativeModule: NativeCrashModule) => void;
  processCrashReports: (nativeModule: NativeCrashModule) => Promise<void>;
};

type TestableIosCrashInstrumentation = {
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

function createNativeCrashModule(
  reports: Array<CrashReport | string>,
  recordSessionContextResult: boolean | undefined = true
): NativeCrashModule {
  return {
    acknowledgeCrashReports: jest.fn().mockResolvedValue(undefined),
    getPendingCrashReports: jest
      .fn()
      .mockResolvedValue(reports.map((report) => (typeof report === 'string' ? report : JSON.stringify(report)))),
    recordCrashSessionContext: jest.fn().mockReturnValue(recordSessionContextResult),
  };
}

function setupAndroidReplay(
  reports: Array<CrashReport | string>,
  beforeSend?: (item: TransportItem) => TransportItem | null,
  recordSessionContextResult: boolean | undefined = true
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

  const nativeModule = createNativeCrashModule(reports, recordSessionContextResult);
  const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({
    outcome: 'accepted',
    status: 202,
  });
  const testable = instrumentation as unknown as TestableAndroidCrashInstrumentation;
  testable.prepareCrashReporting(nativeModule);

  return { faro, instrumentation, nativeModule, sendSpy, testable };
}

function setupIosReplay(reports: Array<CrashReport | string>) {
  const transport = new FetchTransport({ url: 'http://example.com/collect' });
  const instrumentation = new IosCrashReportingInstrumentation({ enabled: false });
  const faro = initializeFaro(
    mockConfig({
      transports: [transport],
      instrumentations: [instrumentation],
    })
  );
  faro.api.setSession({ id: 'session-b' });

  const nativeModule = createNativeCrashModule(reports);
  const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({
    outcome: 'accepted',
    status: 202,
  });
  const testable = instrumentation as unknown as TestableIosCrashInstrumentation;
  testable.prepareCrashReporting(nativeModule);

  return { faro, instrumentation, nativeModule, sendSpy, testable };
}

describe('CrashReportingInstrumentation', () => {
  const androidInstrumentations: AndroidCrashReportingInstrumentation[] = [];
  const iosInstrumentations: IosCrashReportingInstrumentation[] = [];

  beforeEach(() => {
    jest.restoreAllMocks();
    delete (global as any).faro;
  });

  afterEach(() => {
    androidInstrumentations.splice(0).forEach((instrumentation) => instrumentation.unpatch());
    iosInstrumentations.splice(0).forEach((instrumentation) => instrumentation.unpatch());
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

  describe.each([
    ['Android', AndroidCrashReportingInstrumentation],
    ['iOS', IosCrashReportingInstrumentation],
  ] as const)('%s replay with session sampling', (_platform, CrashInstrumentation) => {
    function setupSampledReplay(reports: CrashReport[], rate: number) {
      VolatileSessionsManager.removeUserSession();
      const transport = new FetchTransport({ url: 'http://example.com/collect' });
      const instrumentation = new CrashInstrumentation({ enabled: false });
      const sessionInstrumentation = new SessionInstrumentation();
      initializeFaro(
        mockConfig({
          transports: [transport],
          instrumentations: [sessionInstrumentation, instrumentation],
          sessionTracking: { enabled: true, persistent: false, sampling: new SamplingRate(rate) },
        })
      );
      const nativeModule = createNativeCrashModule(reports);
      const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({ outcome: 'accepted', status: 202 });
      const testable = instrumentation as unknown as TestableAndroidCrashInstrumentation;
      testable.prepareCrashReporting(nativeModule);
      return { instrumentation, nativeModule, sendSpy, sessionInstrumentation, testable };
    }

    it.each([
      ['drops', 0, 0],
      ['sends', 1, 1],
    ] as const)(
      '%s an older crash without a sampling decision using the live session decision',
      async (_name, rate, expectedSends) => {
        const setup = setupSampledReplay([createCrashReport({ sessionId: 'session-a' })], rate);

        try {
          await setup.testable.processCrashReports(setup.nativeModule);

          expect(setup.sendSpy).toHaveBeenCalledTimes(expectedSends);
          if (expectedSends === 1) {
            const item = setup.sendSpy.mock.calls[0]?.[0]?.[0] as TransportItem<ExceptionEvent>;
            expect(item.meta.session).toStrictEqual({ id: 'session-a' });
          }
        } finally {
          setup.instrumentation.unpatch();
          setup.sessionInstrumentation.unpatch();
        }
      }
    );

    it('drops a crash recorded as unsampled while the live session is sampled', async () => {
      const setup = setupSampledReplay([createCrashReport({ sessionId: 'session-a', isSampled: false })], 1);

      try {
        await setup.testable.processCrashReports(setup.nativeModule);

        expect(setup.sendSpy).not.toHaveBeenCalled();
      } finally {
        setup.instrumentation.unpatch();
        setup.sessionInstrumentation.unpatch();
      }
    });
  });

  it('retains the crash-time sampling decision across same-session metadata updates', () => {
    const setup = setupAndroidReplay([]);
    androidInstrumentations.push(setup.instrumentation);

    setup.faro.api.setSession({
      id: 'session-b',
      attributes: { isSampled: 'false' },
    });
    expect(setup.nativeModule.recordCrashSessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-b', isSampled: false })
    );

    setup.faro.api.setSession({
      id: 'session-b',
      attributes: { custom: 'value' },
    });

    expect(setup.nativeModule.recordCrashSessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-b', isSampled: false })
    );
  });

  it('does not carry a sampling decision into a different session', () => {
    const setup = setupAndroidReplay([]);
    androidInstrumentations.push(setup.instrumentation);

    setup.faro.api.setSession({
      id: 'session-b',
      attributes: { isSampled: 'false' },
    });

    setup.faro.api.setSession({ id: 'session-c' });

    const recordedContext = setup.nativeModule.recordCrashSessionContext.mock.lastCall?.[0];
    expect(recordedContext).toEqual(
      expect.objectContaining({
        sessionId: 'session-c',
        activatedAt: expect.any(Number),
      })
    );
    expect(recordedContext).not.toHaveProperty('isSampled');
  });

  it('replays an iOS crash with its original session and acknowledges it after delivery', async () => {
    const crashTimestamp = Date.now() - 1000;
    const setup = setupIosReplay([
      createCrashReport({
        reason: 'SIGSEGV',
        reportId: 'ios-report-a',
        sessionId: 'session-a',
        timestamp: crashTimestamp,
      }),
    ]);
    iosInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(1);
    const item = setup.sendSpy.mock.calls[0]?.[0]?.[0] as TransportItem<ExceptionEvent>;
    expect(item.meta.session?.id).toBe('session-a');
    expect(item.payload.timestamp).toBe(new Date(crashTimestamp).toISOString());
    expect(setup.faro.metas.value.session?.id).toBe('session-b');
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['ios-report-a']);
  });

  it('uses legacy iOS crash replay when the native module does not support acknowledgements', async () => {
    const transport = new MockTransport();
    const instrumentation = new IosCrashReportingInstrumentation({ enabled: false });
    const faro = initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [instrumentation],
      })
    );
    faro.api.setSession({ id: 'session-b' });
    iosInstrumentations.push(instrumentation);

    const nativeModule = {
      getCrashReport: jest.fn().mockResolvedValue([JSON.stringify(createCrashReport())]),
    } as unknown as NativeCrashModule;
    const testable = instrumentation as unknown as TestableIosCrashInstrumentation;
    testable.prepareCrashReporting(nativeModule);

    await testable.processCrashReports(nativeModule);

    expect(nativeModule.getCrashReport).toHaveBeenCalledTimes(1);
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0]?.meta.session?.id).toBe('session-b');
  });

  it('leaves an iOS crash pending when delivery fails', async () => {
    const setup = setupIosReplay([createCrashReport({ reportId: 'ios-report-a' })]);
    iosInstrumentations.push(setup.instrumentation);
    setup.sendSpy.mockResolvedValue({ outcome: 'failed' });

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).toHaveBeenCalledTimes(1);
    expect(setup.nativeModule.acknowledgeCrashReports).not.toHaveBeenCalled();
  });

  it('discards an iOS crash without assigning the current session when its original session is unavailable', async () => {
    const setup = setupIosReplay([
      createCrashReport({
        reportId: 'ios-report-a',
        sessionId: undefined,
      }),
    ]);
    iosInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.faro.metas.value.session?.id).toBe('session-b');
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['ios-report-a']);
  });

  it('discards an iOS crash older than the replay window', async () => {
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const setup = setupIosReplay([
      createCrashReport({
        reportId: 'ios-report-a',
        timestamp: now - 7 * 24 * 60 * 60 * 1000 - 1,
      }),
    ]);
    iosInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['ios-report-a']);
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

  it('retries persisting session context until native storage confirms success', () => {
    const setup = setupAndroidReplay([], undefined, false);
    androidInstrumentations.push(setup.instrumentation);
    setup.nativeModule.recordCrashSessionContext.mockReturnValue(undefined);

    setup.testable.prepareCrashReporting(setup.nativeModule);
    setup.testable.prepareCrashReporting(setup.nativeModule);

    expect(setup.nativeModule.recordCrashSessionContext).toHaveBeenCalledTimes(3);
    expect(setup.nativeModule.recordCrashSessionContext).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ sessionId: 'session-b' })
    );
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

  it('acknowledges a report without sending it when the original session context is missing', async () => {
    const setup = setupAndroidReplay([createCrashReport({ sessionId: undefined })]);
    androidInstrumentations.push(setup.instrumentation);

    await setup.testable.processCrashReports(setup.nativeModule);

    expect(setup.sendSpy).not.toHaveBeenCalled();
    expect(setup.nativeModule.acknowledgeCrashReports).toHaveBeenCalledWith(['report-a']);
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

  describe('relaunch device state', () => {
    const relaunchState = new DynamicDeviceStateProvider(
      () => 0,
      DYNAMIC_DEVICE_STATE_TTL_MS,
      () => ({
        device: { battery_level: 9, is_charging: true, low_power_mode: true, thermal_state: 'serious' },
        network: { connection_type: 'wifi' },
      })
    );
    const dynamicMetas = [getDynamicDeviceStateMeta({ is_physical: true, brand: 'Apple' }, undefined, relaunchState)];
    const relaunchSessionAttributes = {
      device_battery_level: '9',
      device_is_charging: 'true',
      device_low_power_mode: 'true',
      device_carrier: 'Verizon',
      device_brand: 'Apple',
    };

    it('does not send the relaunch values with a crash sent through the legacy path', () => {
      const transport = new MockTransport();
      const instrumentation = new CrashReportingInstrumentation({ enabled: false });
      const faro = initializeFaro(
        mockConfig({ metas: dynamicMetas, transports: [transport], instrumentations: [instrumentation] })
      );
      faro.api.setSession({ id: 'session-b', attributes: relaunchSessionAttributes });
      const execute = faro.transports.execute;

      (instrumentation as unknown as { sendCrashReport: (crash: CrashReport) => void }).sendCrashReport(
        createCrashReport()
      );
      faro.api.pushLog(['live']);

      const [crash, live] = transport.items;
      expect(crash?.type).toBe('exception');
      expect(crash?.meta.device).toEqual({ is_physical: true, brand: 'Apple' });
      expect(crash?.meta).not.toHaveProperty('network');
      expect(crash?.meta.session?.attributes).toEqual({ device_brand: 'Apple' });
      expect(live?.meta.device).toMatchObject({ battery_level: 9, thermal_state: 'serious' });
      expect(live?.meta).toHaveProperty('network', { connection_type: 'wifi' });
      expect(live?.meta.session?.attributes).toEqual(relaunchSessionAttributes);
      expect(faro.transports.execute).toBe(execute);
    });

    it('does not send the relaunch values with a crash buffered by an active user action', () => {
      const transport = new MockTransport();
      const instrumentation = new CrashReportingInstrumentation({ enabled: false });
      const faro = initializeFaro(
        mockConfig({ metas: dynamicMetas, transports: [transport], instrumentations: [instrumentation] })
      );
      faro.api.setSession({ id: 'session-b', attributes: relaunchSessionAttributes });
      const action = faro.api.startUserAction('tap');
      expect(faro.api.getActiveUserAction()).toBe(action);

      (instrumentation as unknown as { sendCrashReport: (crash: CrashReport) => void }).sendCrashReport(
        createCrashReport()
      );
      expect(transport.items).toHaveLength(0);
      (action as unknown as { end: () => void }).end();

      const crash = transport.items.find((item) => item.type === 'exception');
      expect(crash).toBeDefined();
      expect(crash?.meta.device).toEqual({ is_physical: true, brand: 'Apple' });
      expect(crash?.meta).not.toHaveProperty('network');
      expect(crash?.meta.session?.attributes).toEqual({ device_brand: 'Apple' });
      expect(typeof (action as unknown as { addItem: unknown }).addItem).toBe('function');
    });

    it('does not send the relaunch values with a crash whose JSON cannot be parsed', async () => {
      const transport = new MockTransport();
      const instrumentation = new IosCrashReportingInstrumentation({ enabled: false });
      const faro = initializeFaro(
        mockConfig({ metas: dynamicMetas, transports: [transport], instrumentations: [instrumentation] })
      );
      faro.api.setSession({ id: 'session-b', attributes: relaunchSessionAttributes });
      iosInstrumentations.push(instrumentation);
      const nativeModule = {
        getCrashReport: jest.fn().mockResolvedValue(['{not json']),
      } as unknown as NativeCrashModule;
      const testable = instrumentation as unknown as TestableIosCrashInstrumentation;
      testable.prepareCrashReporting(nativeModule);
      const execute = faro.transports.execute;

      await testable.processCrashReports(nativeModule);

      expect(transport.items).toHaveLength(1);
      const [crash] = transport.items;
      expect((crash?.payload as ExceptionEvent).value).toBe('Application crash (parse error)');
      expect(crash?.meta.device).toEqual({ is_physical: true, brand: 'Apple' });
      expect(crash?.meta).not.toHaveProperty('network');
      expect(crash?.meta.session?.attributes).toEqual({ device_brand: 'Apple' });
      expect(faro.transports.execute).toBe(execute);
    });

    it('does not send the relaunch values with a crash replayed from its original session', async () => {
      const transport = new FetchTransport({ url: 'http://example.com/collect' });
      const instrumentation = new AndroidCrashReportingInstrumentation({ enabled: false });
      const faro = initializeFaro(
        mockConfig({ metas: dynamicMetas, transports: [transport], instrumentations: [instrumentation] })
      );
      faro.api.setSession({ id: 'session-b', attributes: relaunchSessionAttributes });
      androidInstrumentations.push(instrumentation);
      const nativeModule = createNativeCrashModule([createCrashReport()]);
      const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({ outcome: 'accepted', status: 202 });
      const testable = instrumentation as unknown as TestableAndroidCrashInstrumentation;
      testable.prepareCrashReporting(nativeModule);

      expect(faro.metas.value.device).toMatchObject({ battery_level: 9 });

      await testable.processCrashReports(nativeModule);

      const item = sendSpy.mock.calls[0]?.[0]?.[0] as TransportItem<ExceptionEvent>;
      expect(item.meta.session?.id).toBe('session-a');
      expect(item.meta).not.toHaveProperty('device');
      expect(item.meta).not.toHaveProperty('network');
      expect(item.meta.session?.attributes?.['device_battery_level']).toBeUndefined();
    });
  });

  describe('metadata of the crashed process', () => {
    const savedMeta = {
      sdk: { name: '@grafana/faro-react-native', version: '1.0.0', integrations: [] },
      app: { name: 'shop', environment: 'production', installationId: 'install-a', version: '1.2.3' },
      os: { name: 'Android', version: '13' },
      device: { brand: 'Google', is_physical: true },
      page: { id: 'page-a', url: 'Checkout' },
      view: { name: 'Checkout' },
      sessionAttributes: { device_brand: 'Google', plan: 'pro' },
      dynamicGroups: { battery: true, thermal: true, network: true },
    };
    const relaunchSessionAttributes = { device_battery_level: '9', device_brand: 'Apple', plan: 'free' };

    afterEach(() => {
      setUserPersistence(null);
    });

    function setupRelaunchedReplay(report: CrashReport) {
      const transport = new FetchTransport({ url: 'http://example.com/collect' });
      const instrumentation = new AndroidCrashReportingInstrumentation({ enabled: false });
      const faro = initializeFaro(
        mockConfig({
          metas: [
            () => ({
              sdk: { name: '@grafana/faro-react-native', version: '2.0.0', integrations: [] },
              app: { name: 'shop', environment: 'staging', version: '2.0.0' },
              os: { name: 'Android', version: '14' },
              user: { id: 'user-b' },
              view: { name: 'Home' },
              page: { id: 'page-b', url: 'Home' },
            }),
            getDynamicDeviceStateMeta(
              { brand: 'Apple' },
              undefined,
              new DynamicDeviceStateProvider(
                () => 0,
                DYNAMIC_DEVICE_STATE_TTL_MS,
                () => ({ device: { battery_level: 9 }, network: { connection_type: 'wifi' } })
              )
            ),
          ],
          transports: [transport],
          instrumentations: [instrumentation],
        })
      );
      faro.api.setSession({ id: 'session-b', attributes: relaunchSessionAttributes });
      androidInstrumentations.push(instrumentation);
      const nativeModule = createNativeCrashModule([report]);
      const sendSpy = jest.spyOn(transport, 'sendWithResult').mockResolvedValue({ outcome: 'accepted', status: 202 });
      const testable = instrumentation as unknown as TestableAndroidCrashInstrumentation;
      testable.prepareCrashReporting(nativeModule);
      return { nativeModule, sendSpy, testable };
    }

    async function replay(report: CrashReport) {
      const setup = setupRelaunchedReplay(report);
      await setup.testable.processCrashReports(setup.nativeModule);
      return setup.sendSpy.mock.calls[0]?.[0]?.[0] as TransportItem<ExceptionEvent>;
    }

    it('saves the static metadata of the running process and leaves out the user and dynamic values when user persistence is off', () => {
      const setup = setupRelaunchedReplay(createCrashReport());

      const saved = setup.nativeModule.recordCrashSessionContext.mock.lastCall?.[0] as { meta?: string };
      const meta = JSON.parse(saved.meta ?? '{}');
      expect(meta).toMatchObject({
        sdk: { version: '2.0.0' },
        app: { environment: 'staging' },
        os: { version: '14' },
        device: { brand: 'Apple' },
        page: { url: 'Home' },
        view: { name: 'Home' },
      });
      expect(meta).not.toHaveProperty('user');
      expect(meta).not.toHaveProperty('network');
      expect(meta.device).not.toHaveProperty('battery_level');
      expect(meta.sessionAttributes).toEqual({ device_brand: 'Apple', plan: 'free' });
      expect(saved.meta).not.toContain('user-b');
    });

    it('saves the user of the running process when user persistence is on', () => {
      setUserPersistence(createUserPersistence());
      const setup = setupRelaunchedReplay(createCrashReport());

      const saved = setup.nativeModule.recordCrashSessionContext.mock.lastCall?.[0] as { meta?: string };
      expect(JSON.parse(saved.meta ?? '{}').user).toEqual({ id: 'user-b' });
    });

    it('replays the user that was saved with the crash instead of the relaunch user', async () => {
      const item = await replay(
        createCrashReport({
          meta: { ...savedMeta, user: { id: 'user-a', email: 'a@example.com', attributes: { plan: 'pro', n: 1 } } },
        })
      );

      expect(item.meta.user).toEqual({ id: 'user-a', email: 'a@example.com', attributes: { plan: 'pro' } });
    });

    it('omits the user when the crashed process saved none', async () => {
      const item = await replay(createCrashReport({ meta: savedMeta }));

      expect(item.meta).not.toHaveProperty('user');
    });

    it('replays the metadata that was saved with the crash instead of the relaunch metadata', async () => {
      const item = await replay(createCrashReport({ meta: savedMeta, isSampled: true, appVersion: '1.2.3' }));

      expect(item.meta.sdk).toEqual(savedMeta.sdk);
      expect(item.meta.app).toEqual(savedMeta.app);
      expect(item.meta.os).toEqual(savedMeta.os);
      expect(item.meta.device).toEqual(savedMeta.device);
      expect(item.meta.page).toEqual(savedMeta.page);
      expect(item.meta.view).toEqual(savedMeta.view);
      expect(item.meta.session).toEqual({
        id: 'session-a',
        attributes: { device_brand: 'Google', plan: 'pro', isSampled: 'true' },
      });
      expect(item.meta).not.toHaveProperty('user');
      expect(item.meta).not.toHaveProperty('network');
    });

    it('adds the dynamic values captured at crash time', async () => {
      const item = await replay(
        createCrashReport({
          meta: savedMeta,
          dynamicDeviceState: {
            batteryLevel: 42,
            isCharging: false,
            thermalState: 'fair',
            connectionType: 'cell',
            connectionSubtype: 'lte',
          },
        })
      );

      expect(item.meta.device).toEqual({
        ...savedMeta.device,
        battery_level: 42,
        is_charging: false,
        thermal_state: 'fair',
      });
      expect(item.meta).toHaveProperty('network', { connection_type: 'cell', connection_subtype: 'lte' });
    });

    it('omits a value that the record did not save instead of using the relaunch value', async () => {
      const item = await replay(createCrashReport({ appVersion: '1.2.3', appBundleId: 'bundle-a' }));

      expect(item.meta.app).toEqual({ version: '1.2.3', bundleId: 'bundle-a' });
      expect(item.meta.session).toEqual({ id: 'session-a' });
      for (const key of ['sdk', 'os', 'device', 'network', 'page', 'view', 'user']) {
        expect(item.meta).not.toHaveProperty(key);
      }
    });

    it('drops a dynamic group that the crashed session turned off', async () => {
      const item = await replay(
        createCrashReport({
          meta: { ...savedMeta, dynamicGroups: { battery: true, thermal: false, network: false } },
          dynamicDeviceState: { batteryLevel: 42, thermalState: 'fair', connectionType: 'cell', carrierName: 'Acme' },
        })
      );

      expect(item.meta.device).toEqual({ ...savedMeta.device, battery_level: 42 });
      expect(item.meta).not.toHaveProperty('network');
    });

    it('drops the dynamic values when the record does not say which groups the session collected', async () => {
      const { dynamicGroups: _dynamicGroups, ...metaWithoutGroups } = savedMeta;
      const item = await replay(
        createCrashReport({
          meta: metaWithoutGroups,
          dynamicDeviceState: { batteryLevel: 42, thermalState: 'fair', connectionType: 'cell' },
        })
      );

      expect(item.meta.device).toEqual(savedMeta.device);
      expect(item.meta).not.toHaveProperty('network');
    });

    it('ignores malformed saved metadata without losing the valid parts', async () => {
      const item = await replay(
        createCrashReport({
          meta: {
            sdk: 'bad',
            os: savedMeta.os,
            view: { name: 5 },
            user: { id: 5 },
            sessionAttributes: { plan: 'pro', n: 1 },
            dynamicGroups: savedMeta.dynamicGroups,
          },
          dynamicDeviceState: { batteryLevel: 'full', connectionType: 'cell' },
        })
      );

      expect(item.meta).not.toHaveProperty('sdk');
      expect(item.meta).not.toHaveProperty('view');
      expect(item.meta).not.toHaveProperty('user');
      expect(item.meta.os).toEqual(savedMeta.os);
      expect(item.meta.session?.attributes).toEqual({ plan: 'pro' });
      expect(item.meta).not.toHaveProperty('device');
      expect(item.meta).toHaveProperty('network', { connection_type: 'cell' });
    });
  });
});
