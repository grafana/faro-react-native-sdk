import type { Config } from '@grafana/faro-core';

import { MmkvPersistentSessionsManager } from './MmkvPersistentSessionsManager';
import type { SessionManager } from './types';
import { VolatileSessionsManager } from './VolatileSessionManager';

export function getSessionManagerByConfig(sessionTrackingConfig: Required<Config>['sessionTracking']): SessionManager {
  if (!sessionTrackingConfig.persistent) {
    return VolatileSessionsManager;
  }

  return MmkvPersistentSessionsManager;
}
