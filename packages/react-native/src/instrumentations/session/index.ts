import { BaseInstrumentation, dateNow, EVENT_SESSION_START, genShortID, VERSION } from '@grafana/faro-core';
import type { Config, Meta, MetaSession, TransportItem } from '@grafana/faro-core';

import type { ReactNativeFullConfig, ReactNativeSessionTrackingConfig } from '../../config/types';

import { minimalSessionDeviceAttributes, type SessionAttributes } from './sessionAttributes';
import { type FaroUserSession, getSessionManagerByConfig, isSampled } from './sessionManager';
import { MAX_SESSION_PERSISTENCE_TIME } from './sessionManager/sessionConstants';
import { createUserSessionObject, isUserSessionValid } from './sessionManager/sessionManagerUtils';
import type { SessionManager } from './sessionManager/types';

/**
 * Session instrumentation for React Native
 * Manages persistent or volatile sessions with expiration and inactivity tracking
 */
export class SessionInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-session';
  readonly version = VERSION;

  // previously notified session, to ensure we don't send session start
  // event twice for the same session
  private notifiedSession: MetaSession | undefined;
  private sessionManagerInstance: InstanceType<SessionManager> | undefined;

  private getDefaultSessionDeviceAttributes(): SessionAttributes {
    const cfg = this.config as ReactNativeFullConfig;
    if (cfg.preloadedSessionDeviceAttributes != null) {
      return cfg.preloadedSessionDeviceAttributes;
    }
    return minimalSessionDeviceAttributes();
  }

  private sendSessionStartEvent(meta: Meta): void {
    const session = meta.session;

    if (session && session.id !== this.notifiedSession?.id) {
      this.notifiedSession = session;
      // no need to add attributes and session id, they are included as part of meta
      // automatically
      this.api.pushEvent(EVENT_SESSION_START, {}, undefined, { skipDedupe: true });
    }
  }

  private createInitialSession(
    SessionManagerClass: SessionManager,
    sessionsConfig: Required<Config>['sessionTracking']
  ): {
    initialSession: FaroUserSession;
    emitSessionStartOnInit: boolean;
  } {
    let storedUserSession = SessionManagerClass.fetchUserSession();

    const sessionsConfigTyped = sessionsConfig as ReactNativeSessionTrackingConfig;
    const maxPersistenceMs = sessionsConfigTyped.maxSessionPersistenceTime ?? MAX_SESSION_PERSISTENCE_TIME;

    if (sessionsConfig.persistent && storedUserSession) {
      const now = dateNow();
      const shouldClearPersistentSession = storedUserSession.lastActivity < now - maxPersistenceMs;

      if (shouldClearPersistentSession) {
        SessionManagerClass.removeUserSession();
        storedUserSession = null;
      }
    }

    const defaultAttributes = this.getDefaultSessionDeviceAttributes();

    let emitSessionStartOnInit: boolean;
    let initialSession: FaroUserSession;

    if (isUserSessionValid(storedUserSession)) {
      const sessionId = storedUserSession?.sessionId;

      initialSession = createUserSessionObject({
        sessionId,
        isSampled: storedUserSession?.isSampled || false,
        started: storedUserSession?.started,
      });

      const storedUserSessionMeta = storedUserSession?.sessionMeta;

      // For resumed sessions we want to merge the previous overrides with the configured ones.
      // If the same key is present in both, the new one will override the old one.
      const overrides = { ...sessionsConfig.session?.overrides, ...storedUserSessionMeta?.overrides };

      initialSession.sessionMeta = {
        ...sessionsConfig.session,
        id: sessionId,
        attributes: {
          // Start with custom attributes from config
          ...sessionsConfig.session?.attributes,
          // Merge with stored attributes
          ...storedUserSessionMeta?.attributes,
          // Default attributes take precedence (matching Flutter SDK behavior)
          ...defaultAttributes,
          // For valid resumed sessions we do not want to recalculate the sampling decision on each init phase.
          isSampled: initialSession.isSampled.toString(),
        },
        overrides,
      };

      emitSessionStartOnInit = false;
    } else {
      const sessionId = sessionsConfig.session?.id ?? genShortID();

      initialSession = createUserSessionObject({
        sessionId,
        isSampled: isSampled(),
      });

      const overrides = sessionsConfig.session?.overrides;

      initialSession.sessionMeta = {
        id: sessionId,
        attributes: {
          isSampled: initialSession.isSampled.toString(),
          // Start with custom attributes from config
          ...sessionsConfig.session?.attributes,
          // Default attributes take precedence (matching Flutter SDK behavior)
          ...defaultAttributes,
        },
        // new session we don't care about previous overrides
        ...(overrides ? { overrides } : {}),
      };

      emitSessionStartOnInit = true;
    }

    return { initialSession, emitSessionStartOnInit };
  }

  private registerBeforeSendHook(SessionManagerClass: SessionManager) {
    const { updateSession } = new SessionManagerClass();

    this.transports?.addBeforeSendHooks((item: TransportItem) => {
      updateSession();

      const attributes = item.meta.session?.attributes;

      // Only filter out items when session is explicitly NOT sampled (isSampled='false')
      // If isSampled='true', remove the attribute before sending (it's internal)
      // If no isSampled attribute, pass through the item unchanged
      if (attributes?.['isSampled'] === 'false') {
        // Session is not sampled - drop this item
        return null;
      }

      if (attributes?.['isSampled'] === 'true') {
        // Session is sampled - remove internal isSampled attribute before sending
        let newItem: TransportItem = JSON.parse(JSON.stringify(item));

        const newAttributes = newItem.meta.session?.attributes;
        delete newAttributes?.['isSampled'];

        if (Object.keys(newAttributes ?? {}).length === 0) {
          delete newItem.meta.session?.attributes;
        }

        return newItem;
      }

      // No isSampled attribute or other value - pass through unchanged
      return item;
    });
  }

  initialize(): void {
    const sessionTrackingConfig = this.config.sessionTracking;

    if (!sessionTrackingConfig?.enabled) {
      this.metas.addListener(this.sendSessionStartEvent.bind(this));
      return;
    }

    const SessionManagerClass = getSessionManagerByConfig(sessionTrackingConfig);

    this.registerBeforeSendHook(SessionManagerClass);

    const { initialSession, emitSessionStartOnInit } = this.createInitialSession(
      SessionManagerClass,
      sessionTrackingConfig
    );
    SessionManagerClass.storeUserSession(initialSession);

    const initialSessionMeta = initialSession.sessionMeta;
    this.notifiedSession = initialSessionMeta;
    this.api.setSession(initialSessionMeta);

    this.sessionManagerInstance = new SessionManagerClass();

    if (emitSessionStartOnInit) {
      this.api.pushEvent(EVENT_SESSION_START, {}, undefined, { skipDedupe: true });
    }

    this.metas.addListener(this.sendSessionStartEvent.bind(this));
  }

  /**
   * Clean up session manager listeners
   */
  unpatch(): void {
    if (this.sessionManagerInstance && 'unpatch' in this.sessionManagerInstance) {
      this.sessionManagerInstance.unpatch();
    }
  }
}
