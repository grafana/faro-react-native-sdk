import { Platform } from 'react-native';

import { AndroidCrashReportingInstrumentation } from './android';
import { IosCrashReportingInstrumentation } from './ios';
import { NoOpCrashReportingInstrumentation } from './NoOpCrashReportingInstrumentation';

function resolveCrashReportingInstrumentation() {
  if (Platform.OS === 'android') {
    return AndroidCrashReportingInstrumentation;
  }

  if (Platform.OS === 'ios') {
    // React Native reports both iPhone and iPadOS as "ios".
    return IosCrashReportingInstrumentation;
  }

  return NoOpCrashReportingInstrumentation;
}

/**
 * Platform-aware crash reporting instrumentation export.
 *
 * At module load time, determines the platform and exports the correct implementation:
 * - Android: Uses ApplicationExitInfo API to retrieve crashes
 * - iOS: Uses PLCrashReporter to retrieve crashes
 * - Other: No-op stub (web, macOS, Windows, etc.)
 *
 * Usage:
 * ```ts
 * import { CrashReportingInstrumentation } from '@grafana/faro-react-native/instrumentation-crash';
 *
 * const faro = initializeFaro({
 *   // ...
 *   instrumentations: [
 *     new CrashReportingInstrumentation(),
 *   ],
 * });
 * ```
 */
export const CrashReportingInstrumentation = resolveCrashReportingInstrumentation();

// Export public API types
export type { CrashReportingOptions } from './types';
