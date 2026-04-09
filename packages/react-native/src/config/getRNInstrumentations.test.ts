import { Platform } from 'react-native';

import { TracingInstrumentation } from '@grafana/faro-react-native-tracing';

import { ANRInstrumentation } from '../instrumentations/anr';
import { AppStateInstrumentation } from '../instrumentations/appState';
import { ConsoleInstrumentation } from '../instrumentations/console';
import { CrashReportingInstrumentation } from '../instrumentations/crashReporting';
import { ErrorsInstrumentation } from '../instrumentations/errors';
import { FrameMonitoringInstrumentation } from '../instrumentations/frameMonitoring';
import { HttpInstrumentation } from '../instrumentations/http';
import { PerformanceInstrumentation } from '../instrumentations/performance';
import { SessionInstrumentation } from '../instrumentations/session';
import { StartupInstrumentation } from '../instrumentations/startup';
import { UserActionInstrumentation } from '../instrumentations/userActions';
import { ViewInstrumentation } from '../instrumentations/view';
import { XHRInstrumentation } from '../instrumentations/xhr';

import { getRNInstrumentations } from './getRNInstrumentations';

/** Narrowing helper for `instanceof` against instrumentation classes (constructors use typed optional options). */
function has(list: unknown[], Cls: abstract new (...args: any[]) => object): boolean {
  return list.some((i) => i instanceof Cls);
}

describe('getRNInstrumentations', () => {
  afterEach(() => {
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  it('default flags include core instrumentations and HTTP when not tracing', () => {
    const list = getRNInstrumentations({});

    expect(has(list, ErrorsInstrumentation)).toBe(true);
    expect(has(list, ConsoleInstrumentation)).toBe(true);
    expect(has(list, SessionInstrumentation)).toBe(true);
    expect(has(list, ViewInstrumentation)).toBe(true);
    expect(has(list, AppStateInstrumentation)).toBe(true);
    expect(has(list, UserActionInstrumentation)).toBe(true);
    expect(has(list, HttpInstrumentation)).toBe(true);
    expect(has(list, XHRInstrumentation)).toBe(true);
    expect(has(list, PerformanceInstrumentation)).toBe(true);
    expect(has(list, StartupInstrumentation)).toBe(true);

    expect(has(list, FrameMonitoringInstrumentation)).toBe(false);
    expect(has(list, CrashReportingInstrumentation)).toBe(false);
    expect(has(list, ANRInstrumentation)).toBe(false);
  });

  it('omits ErrorsInstrumentation when enableErrorReporting is false', () => {
    const list = getRNInstrumentations({ enableErrorReporting: false });
    expect(has(list, ErrorsInstrumentation)).toBe(false);
  });

  it('omits ConsoleInstrumentation when enableConsoleCapture is false', () => {
    const list = getRNInstrumentations({ enableConsoleCapture: false });
    expect(has(list, ConsoleInstrumentation)).toBe(false);
  });

  it('omits UserActionInstrumentation when enableUserActions is false', () => {
    const list = getRNInstrumentations({ enableUserActions: false });
    expect(has(list, UserActionInstrumentation)).toBe(false);
  });

  it('respects enableHttpInstrumentation fetch/xhr toggles when tracing is off', () => {
    const fetchOnly = getRNInstrumentations({
      enableHttpInstrumentation: { fetch: true, xhr: false },
    });
    expect(has(fetchOnly, HttpInstrumentation)).toBe(true);
    expect(has(fetchOnly, XHRInstrumentation)).toBe(false);

    const xhrOnly = getRNInstrumentations({
      enableHttpInstrumentation: { fetch: false, xhr: true },
    });
    expect(has(xhrOnly, HttpInstrumentation)).toBe(false);
    expect(has(xhrOnly, XHRInstrumentation)).toBe(true);
  });

  it('adds FrameMonitoringInstrumentation when refreshRateVitals is true', () => {
    const list = getRNInstrumentations({ refreshRateVitals: true });
    expect(has(list, FrameMonitoringInstrumentation)).toBe(true);
  });

  it('adds CrashReportingInstrumentation when enableCrashReporting is true', () => {
    const list = getRNInstrumentations({ enableCrashReporting: true });
    expect(has(list, CrashReportingInstrumentation)).toBe(true);
  });

  it('adds ANRInstrumentation only on Android when anrTracking is true', () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    expect(has(getRNInstrumentations({ anrTracking: true }), ANRInstrumentation)).toBe(false);

    jest.replaceProperty(Platform, 'OS', 'android');
    expect(has(getRNInstrumentations({ anrTracking: true }), ANRInstrumentation)).toBe(true);
  });

  it('adds TracingInstrumentation and skips fetch/XHR instrumentations when enableTracing is true', () => {
    const list = getRNInstrumentations({ enableTracing: true });
    expect(has(list, TracingInstrumentation)).toBe(true);
    expect(has(list, HttpInstrumentation)).toBe(false);
    expect(has(list, XHRInstrumentation)).toBe(false);
  });
});
