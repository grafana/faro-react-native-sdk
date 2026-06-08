import {
  normalizeCrashTraceExceptionMessage,
  normalizeJavaStackTraceForRetrace,
  parseAndroidCrashTrace,
} from './parseAndroidCrashTrace';

describe('parseAndroidCrashTrace', () => {
  it('parses QuickPizza-style ApplicationExitInfo traces', () => {
    const trace = [
      'com.quickpizza.c: QuickPizza RN intentional native crash',
      '\tat com.quickpizza.c.a(SourceFile:33)',
      '\tat com.quickpizza.c.b(SourceFile:45)',
      '\tat com.quickpizza.c.d(SourceFile)',
      '\tat com.unknown.x.y(SourceFile:7)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed).toEqual({
      exceptionType: 'com.quickpizza.c',
      exceptionMessage: 'QuickPizza RN intentional native crash',
      jsFrames: [],
      frames: [
        {
          module: 'com.quickpizza.c',
          function: 'a',
          filename: 'SourceFile',
          lineno: 33,
        },
        {
          module: 'com.quickpizza.c',
          function: 'b',
          filename: 'SourceFile',
          lineno: 45,
        },
        {
          module: 'com.quickpizza.c',
          function: 'd',
          filename: 'SourceFile',
          lineno: undefined,
        },
        {
          module: 'com.unknown.x',
          function: 'y',
          filename: 'SourceFile',
          lineno: 7,
        },
      ],
    });
  });

  it('parses Android Log.getStackTraceString format', () => {
    const trace = [
      'java.lang.RuntimeException: QuickPizza RN intentional native crash',
      '    at com.quickpizza.QuickPizzaCrashModule.raiseQuickPizzaFailure(QuickPizzaCrashModule.kt:60)',
      '    at com.quickpizza.QuickPizzaCrashModule.triggerRuntimeException(QuickPizzaCrashModule.kt:33)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.exceptionType).toBe('java.lang.RuntimeException');
    expect(parsed?.frames).toEqual([
      {
        module: 'com.quickpizza.QuickPizzaCrashModule',
        function: 'raiseQuickPizzaFailure',
        filename: 'QuickPizzaCrashModule.kt',
        lineno: 60,
      },
      {
        module: 'com.quickpizza.QuickPizzaCrashModule',
        function: 'triggerRuntimeException',
        filename: 'QuickPizzaCrashModule.kt',
        lineno: 33,
      },
    ]);
  });

  it('parses java.lang.RuntimeException headers', () => {
    const trace = [
      'java.lang.RuntimeException: QuickPizza RN intentional native crash',
      '\tat com.quickpizza.c.a(SourceFile:33)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.exceptionType).toBe('java.lang.RuntimeException');
    expect(parsed?.frames).toHaveLength(1);
  });

  it('returns null for empty input', () => {
    expect(parseAndroidCrashTrace('')).toBeNull();
    expect(parseAndroidCrashTrace('   ')).toBeNull();
  });

  it('parses RN fatal JavascriptException ApplicationExitInfo traces', () => {
    const trace = [
      'com.facebook.react.common.JavascriptException: Error: QuickPizza RN unhandled debug exception, stack:',
      'anonymous@1:1390953',
      '',
      '\tat com.facebook.react.modules.core.ExceptionsManagerModule.reportException(ExceptionsManagerModule.kt:52)',
      '\tat android.os.Handler.handleCallback(Handler.java:1070)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace, { releaseBundleFilename: 'index.android.bundle' });

    expect(parsed?.exceptionType).toBe('com.facebook.react.common.JavascriptException');
    expect(parsed?.exceptionMessage).toBe('QuickPizza RN unhandled debug exception');
    expect(parsed?.jsFrames).toEqual([
      {
        function: 'anonymous',
        filename: 'index.android.bundle',
        lineno: 1,
        colno: 1390953,
      },
    ]);
    expect(parsed?.frames[0]).toMatchObject({
      module: 'com.facebook.react.modules.core.ExceptionsManagerModule',
      function: 'reportException',
      filename: 'ExceptionsManagerModule.kt',
      lineno: 52,
    });
  });

  it('parses dev-style JS frames embedded in Android crash traces', () => {
    const trace = [
      'com.facebook.react.common.JavascriptException: Error: QuickPizza RN unhandled debug exception, stack:',
      'at triggerUnhandledException (/Users/me/DebugScreen.tsx:133:7)',
      'at com.facebook.react.modules.core.ExceptionsManagerModule.reportException(ExceptionsManagerModule.kt:52)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.jsFrames[0]).toMatchObject({
      function: 'triggerUnhandledException',
      filename: '/Users/me/DebugScreen.tsx',
      lineno: 133,
      colno: 7,
    });
  });

  it('normalizes RN fatal JS error header shape without relying on exception type', () => {
    expect(normalizeCrashTraceExceptionMessage('Error: QuickPizza RN unhandled debug exception, stack:')).toBe(
      'QuickPizza RN unhandled debug exception'
    );
  });

  it('leaves native exception messages unchanged', () => {
    expect(normalizeCrashTraceExceptionMessage('QuickPizza RN intentional native crash')).toBe(
      'QuickPizza RN intentional native crash'
    );
  });

  it('parses ANRTracker Thread.getStackTrace lines without an "at " prefix', () => {
    const trace = [
      'com.quickpizza.QuickPizzaCrashModule.triggerApplicationNotResponding(QuickPizzaCrashModule.kt:42)',
      'com.quickpizza.QuickPizzaCrashModule.crash(QuickPizzaCrashModule.kt:22)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.frames).toEqual([
      {
        module: 'com.quickpizza.QuickPizzaCrashModule',
        function: 'triggerApplicationNotResponding',
        filename: 'QuickPizzaCrashModule.kt',
        lineno: 42,
      },
      {
        module: 'com.quickpizza.QuickPizzaCrashModule',
        function: 'crash',
        filename: 'QuickPizzaCrashModule.kt',
        lineno: 22,
      },
    ]);
  });

  it('normalizes thread stacks for ingest R8 retrace', () => {
    const raw = 'com.quickpizza.c.a(SourceFile:33)';
    expect(normalizeJavaStackTraceForRetrace(raw)).toBe('    at com.quickpizza.c.a(SourceFile:33)');
  });
});
