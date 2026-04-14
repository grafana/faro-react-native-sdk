import type { MetaSession } from '@grafana/faro-core';

import type { MmkvPersistentSessionsManager } from './MmkvPersistentSessionsManager';
import type { VolatileSessionsManager } from './VolatileSessionManager';

export interface FaroUserSession {
  sessionId: string;
  lastActivity: number;
  started: number;
  isSampled: boolean;
  sessionMeta?: MetaSession;
}

export type SessionManager = typeof VolatileSessionsManager | typeof MmkvPersistentSessionsManager;
