import {
  buildFallbackCrashMessage,
  isAnrTimeoutDescription,
  resolveCrashErrorMessage,
  shouldSkipCrashReport,
  shouldSkipLowSignalCrashReport,
} from './crashErrorMessage';
import type { ParsedAndroidCrashTrace } from './parseAndroidCrashTrace';
import type { CrashReport } from '../types';

const baseCrash: CrashReport = {
  reason: 'CRASH',
  timestamp: 1_700_000_000_000,
  status: 0,
};

describe('resolveCrashErrorMessage', () => {
  it('prefers the parsed trace message', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionMessage: 'Intentional native crash from demo module',
      exceptionType: 'java.lang.RuntimeException',
      jsFrames: [],
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('Intentional native crash from demo module');
  });

  it('uses ApplicationExitInfo description when the trace has no message', () => {
    const crash: CrashReport = {
      ...baseCrash,
      description: 'Input dispatching timed out (com.example.app/.MainActivity is not responding. Waited 5002ms for FocusEvent)',
    };

    expect(resolveCrashErrorMessage(crash, null)).toBe(
      'Input dispatching timed out (com.example.app/.MainActivity is not responding. Waited 5002ms for FocusEvent)',
    );
  });

  it('extracts java exception types from non-generic ApplicationExitInfo descriptions', () => {
    const crash: CrashReport = {
      ...baseCrash,
      description: 'java.lang.NullPointerException: null reference',
    };

    expect(resolveCrashErrorMessage(crash, null)).toBe('java.lang.NullPointerException');
  });

  it('prefers parsed exception type over generic ApplicationExitInfo descriptions such as "crash"', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionType: 'java.lang.NullPointerException',
      jsFrames: [],
      frames: [],
    };
    const crash: CrashReport = {
      ...baseCrash,
      description: 'crash',
    };

    expect(resolveCrashErrorMessage(crash, parsed)).toBe('java.lang.NullPointerException');
  });

  it('falls back to exception type for message-less traces such as NullPointerException', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionType: 'java.lang.NullPointerException',
      jsFrames: [],
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('java.lang.NullPointerException');
  });

  it('uses generic fallback when nothing else is available', () => {
    expect(resolveCrashErrorMessage(baseCrash, null)).toBe('CRASH: Application crash (Java/Kotlin), status: 0');
  });

  it('does not treat version-like tokens as exception types', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionType: '18.2213',
      jsFrames: [],
      frames: [
        {
          module: 'com.example.CrashModule',
          function: 'blockMainThread',
          filename: 'CrashModule.kt',
          lineno: 56,
        },
      ],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('CRASH: Application crash (Java/Kotlin), status: 0');
  });

  it('falls back when the trace has frames but no parseable message or exception type', () => {
    const parsed: ParsedAndroidCrashTrace = {
      jsFrames: [],
      frames: [
        {
          module: 'com.example.CrashModule',
          function: 'triggerNativeCrash',
          filename: 'CrashModule.kt',
          lineno: 60,
        },
      ],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('CRASH: Application crash (Java/Kotlin), status: 0');
  });
});

describe('isAnrTimeoutDescription', () => {
  it('detects Android ANR watchdog descriptions', () => {
    expect(
      isAnrTimeoutDescription(
        'Input dispatching timed out (com.example.app/com.example.app.MainActivity is not responding. Waited 5002ms for FocusEvent)',
      ),
    ).toBe(true);
    expect(isAnrTimeoutDescription('Application Not Responding')).toBe(true);
    expect(isAnrTimeoutDescription('java.lang.RuntimeException: something broke')).toBe(false);
  });
});

describe('shouldSkipCrashReport', () => {
  it('skips ApplicationExitInfo rows with ANR timeout descriptions', () => {
    expect(
      shouldSkipCrashReport({
        ...baseCrash,
        description:
          'Input dispatching timed out (com.example.app/com.example.app.MainActivity is not responding. Waited 5002ms for FocusEvent)',
      }),
    ).toBe(true);
  });

  it('does not skip real crashes with Java exception descriptions', () => {
    expect(
      shouldSkipCrashReport({
        ...baseCrash,
        description: 'java.lang.RuntimeException: Network failure',
        trace: 'java.lang.RuntimeException: Network failure\n    at com.example.Foo.bar(Foo.kt:1)',
      }),
    ).toBe(false);
  });
});

describe('shouldSkipLowSignalCrashReport', () => {
  it('skips trace-less rows with only generic descriptions', () => {
    expect(
      shouldSkipLowSignalCrashReport({
        ...baseCrash,
        description: 'Application crash (Java/Kotlin)',
      }),
    ).toBe(true);
  });

  it('keeps rows that carry a native trace', () => {
    expect(
      shouldSkipLowSignalCrashReport({
        ...baseCrash,
        trace: 'java.lang.NullPointerException\n    at com.example.Foo.bar(Foo.kt:1)',
      }),
    ).toBe(false);
  });

  it('keeps rows with a specific ApplicationExitInfo description', () => {
    expect(
      shouldSkipLowSignalCrashReport({
        ...baseCrash,
        description: 'java.lang.RuntimeException: intentional native crash',
      }),
    ).toBe(false);
  });
});

describe('buildFallbackCrashMessage', () => {
  it('formats native crash reasons', () => {
    expect(buildFallbackCrashMessage({ ...baseCrash, reason: 'CRASH_NATIVE' })).toBe(
      'CRASH_NATIVE: Application crash (Native), status: 0',
    );
  });
});
