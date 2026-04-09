/**
 * Jest stub for optional peer `@grafana/faro-react-native-tracing`.
 * Mapped via moduleNameMapper so tests run without installing the tracing workspace package.
 */
import { BaseInstrumentation, VERSION } from '@grafana/faro-core';

export class TracingInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native-tracing';
  readonly version = VERSION;

  initialize(): void {}
}
