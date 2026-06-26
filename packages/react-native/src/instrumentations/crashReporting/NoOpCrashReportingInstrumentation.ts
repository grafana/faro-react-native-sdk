import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

import type { CrashReportingOptions } from './types';

/**
 * Crash reporting stub for platforms other than Android and iOS (e.g. web, macOS, Windows).
 */
export class NoOpCrashReportingInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-crash-noop';
  readonly version = VERSION;

  constructor(_options: CrashReportingOptions = {}) {
    super();
  }

  initialize(): void {
    this.logDebug('Crash reporting is not supported on this platform');
  }

  unpatch(): void {
    // No patching to undo
  }
}
