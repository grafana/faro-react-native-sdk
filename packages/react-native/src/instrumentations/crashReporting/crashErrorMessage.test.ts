import { buildFallbackCrashMessage, resolveCrashErrorMessage } from './crashErrorMessage';
import type { ParsedAndroidCrashTrace } from './parseAndroidCrashTrace';
import type { CrashReport } from './types';

const baseCrash: CrashReport = {
  reason: 'CRASH',
  timestamp: 1_700_000_000_000,
  status: 0,
};

describe('resolveCrashErrorMessage', () => {
  it('prefers the parsed trace message', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionMessage: 'QuickPizza RN intentional native crash',
      exceptionType: 'java.lang.RuntimeException',
      jsFrames: [],
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('QuickPizza RN intentional native crash');
  });

  it('uses ApplicationExitInfo description when the trace has no message', () => {
    const crash: CrashReport = {
      ...baseCrash,
      description: 'Input dispatching timed out (com.quickpizza/.MainActivity)',
    };

    expect(resolveCrashErrorMessage(crash, null)).toBe(
      'Input dispatching timed out (com.quickpizza/.MainActivity)',
    );
  });

  it('falls back to exception type for message-less traces such as NullPointerException', () => {
    const parsed: ParsedAndroidCrashTrace = {
      exceptionType: 'java.lang.NullPointerException',
      jsFrames: [],
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('java.lang.NullPointerException');
  });

  it('uses Flutter-style fallback when nothing else is available', () => {
    expect(resolveCrashErrorMessage(baseCrash, null)).toBe('CRASH: Application crash (Java/Kotlin), status: 0');
  });
});

describe('buildFallbackCrashMessage', () => {
  it('formats native crash reasons', () => {
    expect(buildFallbackCrashMessage({ ...baseCrash, reason: 'CRASH_NATIVE' })).toBe(
      'CRASH_NATIVE: Application crash (Native), status: 0',
    );
  });
});
