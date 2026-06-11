import { Platform } from 'react-native';

import { AndroidCrashReportingInstrumentation } from './android';
import { IosCrashReportingInstrumentation } from './ios';

/**
 * Platform-aware crash reporting instrumentation export.
 *
 * At module load time, determines the platform and exports the correct implementation:
 * - Android: Uses ApplicationExitInfo API to retrieve crashes
 * - iOS: Uses PLCrashReporter to retrieve crashes
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
export const CrashReportingInstrumentation =
  Platform.OS === 'android' ? AndroidCrashReportingInstrumentation : IosCrashReportingInstrumentation;

// Export public API types
export type { CrashReportingOptions } from './types';
