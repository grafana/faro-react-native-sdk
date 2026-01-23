import { noop } from '@grafana/faro-core';
import type { InternalLogger } from '@grafana/faro-core';

export const mockInternalLogger: InternalLogger = {
  prefix: 'Faro',
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
