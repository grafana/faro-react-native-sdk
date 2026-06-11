import {
  normalizeCrashTraceExceptionMessage,
  normalizeJavaStackTraceForRetrace,
  parseAndroidCrashTrace,
} from './parseAndroidCrashTrace';

describe('parseAndroidCrashTrace', () => {
  it('parses obfuscated ApplicationExitInfo traces', () => {
    const trace = [
      'com.example.c: Intentional native crash',
      '\tat com.example.c.a(SourceFile:33)',
      '\tat com.example.c.b(SourceFile:45)',
      '\tat com.example.c.d(SourceFile)',
      '\tat com.unknown.x.y(SourceFile:7)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed).toEqual({
      exceptionType: 'com.example.c',
      exceptionMessage: 'Intentional native crash',
      jsFrames: [],
      frames: [
        {
          module: 'com.example.c',
          function: 'a',
          filename: 'SourceFile',
          lineno: 33,
        },
        {
          module: 'com.example.c',
          function: 'b',
          filename: 'SourceFile',
          lineno: 45,
        },
        {
          module: 'com.example.c',
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
      'java.lang.RuntimeException: Intentional native crash',
      '    at com.example.CrashModule.raiseFailure(CrashModule.kt:60)',
      '    at com.example.CrashModule.triggerRuntimeException(CrashModule.kt:33)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.exceptionType).toBe('java.lang.RuntimeException');
    expect(parsed?.frames).toEqual([
      {
        module: 'com.example.CrashModule',
        function: 'raiseFailure',
        filename: 'CrashModule.kt',
        lineno: 60,
      },
      {
        module: 'com.example.CrashModule',
        function: 'triggerRuntimeException',
        filename: 'CrashModule.kt',
        lineno: 33,
      },
    ]);
  });

  it('parses java.lang.RuntimeException headers', () => {
    const trace = ['java.lang.RuntimeException: Intentional native crash', '\tat com.example.c.a(SourceFile:33)'].join(
      '\n'
    );

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
      'com.facebook.react.common.JavascriptException: Error: Unhandled debug exception, stack:',
      'anonymous@1:1390953',
      '',
      '\tat com.facebook.react.modules.core.ExceptionsManagerModule.reportException(ExceptionsManagerModule.kt:52)',
      '\tat android.os.Handler.handleCallback(Handler.java:1070)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace, { releaseBundleFilename: 'index.android.bundle' });

    expect(parsed?.exceptionType).toBe('com.facebook.react.common.JavascriptException');
    expect(parsed?.exceptionMessage).toBe('Unhandled debug exception');
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
      'com.facebook.react.common.JavascriptException: Error: Unhandled debug exception, stack:',
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
    expect(normalizeCrashTraceExceptionMessage('Error: Unhandled debug exception, stack:')).toBe(
      'Unhandled debug exception'
    );
  });

  it('leaves native exception messages unchanged', () => {
    expect(normalizeCrashTraceExceptionMessage('Intentional native crash')).toBe('Intentional native crash');
  });

  it('parses ANRTracker Thread.getStackTrace lines without an "at " prefix', () => {
    const trace = [
      'com.example.CrashModule.blockMainThread(CrashModule.kt:42)',
      'com.example.CrashModule.crash(CrashModule.kt:22)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.frames).toEqual([
      {
        module: 'com.example.CrashModule',
        function: 'blockMainThread',
        filename: 'CrashModule.kt',
        lineno: 42,
      },
      {
        module: 'com.example.CrashModule',
        function: 'crash',
        filename: 'CrashModule.kt',
        lineno: 22,
      },
    ]);
  });

  it('normalizes thread stacks for ingest R8 retrace', () => {
    const raw = 'com.example.c.a(SourceFile:33)';
    expect(normalizeJavaStackTraceForRetrace(raw)).toBe('    at com.example.c.a(SourceFile:33)');
  });

  it('ignores version-like header lines such as 18.2213', () => {
    const trace = ['18.2213', '    at com.example.CrashModule.blockMainThread(CrashModule.kt:56)'].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    expect(parsed?.exceptionType).toBeUndefined();
    expect(parsed?.frames).toHaveLength(1);
  });

  it('captures root cause from wrapped exceptions with "Caused by:" chain', () => {
    const trace = [
      'java.lang.RuntimeException: Wrapper exception',
      '    at com.example.OuterClass.method(OuterClass.kt:10)',
      'Caused by: java.lang.IllegalStateException: Middle exception',
      '    at com.example.MiddleClass.method(MiddleClass.kt:20)',
      'Caused by: java.lang.NullPointerException: Root cause',
      '    at com.example.InnerClass.method(InnerClass.kt:30)',
    ].join('\n');

    const parsed = parseAndroidCrashTrace(trace);

    // Should capture the root cause (last "Caused by:")
    expect(parsed?.exceptionType).toBe('java.lang.NullPointerException');
    expect(parsed?.exceptionMessage).toBe('Root cause');
    expect(parsed?.frames).toHaveLength(3);
  });
});
