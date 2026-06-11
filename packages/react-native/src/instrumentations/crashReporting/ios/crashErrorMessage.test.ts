import type { CrashReport } from '../types';

import { buildFallbackCrashMessage, resolveCrashErrorMessage, shouldSkipCrashReport } from './crashErrorMessage';
import type { ParsedIosCrashTrace } from './parseIosCrashTrace';

const baseCrash: CrashReport = {
  reason: 'SIGSEGV',
  timestamp: 1_700_000_000_000,
  status: 0,
};

describe('resolveCrashErrorMessage', () => {
  it('prefers exception name and reason for uncaught exceptions', () => {
    const parsed: ParsedIosCrashTrace = {
      exceptionName: 'NSInternalInconsistencyException',
      exceptionReason: 'unable to dequeue a cell with identifier Cell',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe(
      'NSInternalInconsistencyException: unable to dequeue a cell with identifier Cell'
    );
  });

  it('uses exception name alone if no reason', () => {
    const parsed: ParsedIosCrashTrace = {
      exceptionName: 'NSRangeException',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('NSRangeException');
  });

  it('uses signal description from parsed trace', () => {
    const parsed: ParsedIosCrashTrace = {
      signalDescription: 'Segmentation fault',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('Segmentation fault');
  });

  it('uses signal name from parsed trace', () => {
    const parsed: ParsedIosCrashTrace = {
      signalName: 'SIGSEGV',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('Segmentation fault');
  });

  it('maps known signal names to descriptions', () => {
    const parsed: ParsedIosCrashTrace = {
      signalName: 'SIGABRT',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('Abort trap');
  });

  it('uses signal name as-is if unknown', () => {
    const parsed: ParsedIosCrashTrace = {
      signalName: 'SIGUNKNOWN',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('SIGUNKNOWN');
  });

  it('falls back to crash description if present', () => {
    expect(resolveCrashErrorMessage({ ...baseCrash, description: 'Fatal error' }, null)).toBe('Fatal error');
  });

  it('uses crash reason with signal mapping', () => {
    expect(resolveCrashErrorMessage({ ...baseCrash, reason: 'SIGBUS' }, null)).toBe('Bus error');
  });

  it('skips generic crash descriptions', () => {
    const crashWithGeneric = { ...baseCrash, description: 'Application crash' };
    expect(resolveCrashErrorMessage(crashWithGeneric, null)).toBe('SIGSEGV: Segmentation fault, status: 0');
  });

  it('recognizes all generic crash description variations (case-insensitive)', () => {
    expect(resolveCrashErrorMessage({ ...baseCrash, description: 'CRASH' }, null)).toBe(
      'SIGSEGV: Segmentation fault, status: 0'
    );
    expect(resolveCrashErrorMessage({ ...baseCrash, description: 'Application Crash' }, null)).toBe(
      'SIGSEGV: Segmentation fault, status: 0'
    );
    expect(resolveCrashErrorMessage({ ...baseCrash, description: 'Signal Crash' }, null)).toBe(
      'SIGSEGV: Segmentation fault, status: 0'
    );
  });

  it('uses simple signal description when no description is provided', () => {
    expect(resolveCrashErrorMessage(baseCrash, null)).toBe('Segmentation fault');
  });

  it('uses exception reason alone with default "Exception" name', () => {
    const parsed: ParsedIosCrashTrace = {
      exceptionReason: 'Array index out of bounds',
      frames: [],
    };

    expect(resolveCrashErrorMessage(baseCrash, parsed)).toBe('Exception: Array index out of bounds');
  });

  it('uses meaningful description even for unknown crash reason', () => {
    const crashWithUnknownReason = { ...baseCrash, reason: 'CUSTOM_SIGNAL', description: 'Custom error' };
    expect(resolveCrashErrorMessage(crashWithUnknownReason, null)).toBe('Custom error');
  });

  it('uses buildFallbackCrashMessage for unknown signal with no description', () => {
    const crashWithUnknownReason = { reason: 'CUSTOM_SIGNAL', timestamp: 123, status: 5 };
    expect(resolveCrashErrorMessage(crashWithUnknownReason, null)).toBe('CUSTOM_SIGNAL: Application crash, status: 5');
  });

  it('handles empty/whitespace strings correctly', () => {
    const crashWithEmptyDescription = { ...baseCrash, description: '   ' };
    expect(resolveCrashErrorMessage(crashWithEmptyDescription, null)).toBe('Segmentation fault');
  });
});

describe('shouldSkipCrashReport', () => {
  it('keeps crashes with trace', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, trace: '0  MyApp  0x100abc123' })).toBe(false);
  });

  it('keeps crashes with signal', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, signal: 'SIGSEGV (11)' })).toBe(false);
  });

  it('keeps crashes with meaningful description', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, description: 'Fatal error in module' })).toBe(false);
  });

  it('skips crashes with no useful information', () => {
    expect(shouldSkipCrashReport({ reason: 'UNKNOWN', timestamp: 123, status: 0 })).toBe(true);
  });

  it('skips crashes with only generic descriptions', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, description: 'crash' })).toBe(true);
  });

  it('handles empty/whitespace trace and signal correctly', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, trace: '   ', signal: '   ' })).toBe(true);
  });

  it('keeps crashes with signal crash description if trace or signal present', () => {
    expect(shouldSkipCrashReport({ ...baseCrash, trace: 'stack', description: 'signal crash' })).toBe(false);
  });
});

describe('buildFallbackCrashMessage', () => {
  it('builds fallback with known signal', () => {
    expect(buildFallbackCrashMessage({ reason: 'SIGSEGV', timestamp: 123, status: 11 })).toBe(
      'SIGSEGV: Segmentation fault, status: 11'
    );
  });

  it('uses description for unknown signals', () => {
    expect(
      buildFallbackCrashMessage({ reason: 'CUSTOM', timestamp: 123, status: 0, description: 'Custom crash' })
    ).toBe('CUSTOM: Custom crash, status: 0');
  });

  it('handles missing reason', () => {
    expect(buildFallbackCrashMessage({ timestamp: 123, status: 0 })).toBe('UNKNOWN: Application crash, status: 0');
  });
});
