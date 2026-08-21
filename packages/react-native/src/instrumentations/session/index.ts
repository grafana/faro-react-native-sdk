import { BaseInstrumentation, dateNow, EVENT_SESSION_START, VERSION } from '@grafana/faro-core';
import type { Config, Meta, MetaSession, TransportItem } from '@grafana/faro-core';

import type { ReactNativeFullConfig, ReactNativeSessionTrackingConfig } from '../../config/types';

import { clearDirectSessionActivityHandler, registerDirectSessionActivityHandler } from './directSessionActivity';
import { classifySessionActivity, isRecoveredCrashItem, SessionActivityKind } from './sessionActivity';
import { minimalSessionDeviceAttributes, type SessionAttributes } from './sessionAttributes';
import { type FaroUserSession, getSessionManagerByConfig, isSampled } from './sessionManager';
import { MAX_SESSION_PERSISTENCE_TIME } from './sessionManager/sessionConstants';
import { createUserSessionObject, isUserSessionValid } from './sessionManager/sessionManagerUtils';
import type { SessionManager, SessionManagerInstance } from './sessionManager/types';

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
  private unregisterDirectSessionActivity: (() => void) | undefined;

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
      const shouldClearPersistentSession =
        storedUserSession.started > now ||
        storedUserSession.lastActivity > now ||
        storedUserSession.lastActivity <= now - maxPersistenceMs;

      if (shouldClearPersistentSession) {
        SessionManagerClass.removeUserSession();
        storedUserSession = null;
      }
    }

    const defaultAttributes = this.getDefaultSessionDeviceAttributes();

    let emitSessionStartOnInit: boolean;
    let initialSession: FaroUserSession;

    if (!sessionsConfig.persistent && isUserSessionValid(storedUserSession)) {
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
          // Default attributes take precedence
          ...defaultAttributes,
          // For valid resumed sessions we do not want to recalculate the sampling decision on each init phase.
          isSampled: initialSession.isSampled.toString(),
        },
        overrides,
      };

      emitSessionStartOnInit = false;
    } else {
      initialSession = createUserSessionObject({
        sessionId: sessionsConfig.session?.id,
        isSampled: isSampled(),
      });

      const sessionId = initialSession.sessionId;
      const previousSessionId = storedUserSession?.sessionId === sessionId ? undefined : storedUserSession?.sessionId;
      const overrides = sessionsConfig.session?.overrides;

      initialSession.sessionMeta = {
        id: sessionId,
        attributes: {
          // Start with custom attributes from config
          ...sessionsConfig.session?.attributes,
          // Default attributes take precedence
          ...defaultAttributes,
          isSampled: initialSession.isSampled.toString(),
          ...(previousSessionId == null ? {} : { previousSession: previousSessionId }),
        },
        // new session we don't care about previous overrides
        ...(overrides ? { overrides } : {}),
      };

      emitSessionStartOnInit = true;
    }

    return { initialSession, emitSessionStartOnInit };
  }

  private registerBeforeSendHook(sessionManager: SessionManagerInstance, SessionManagerClass: SessionManager): void {
    this.transports?.addBeforeSendHooks((item: TransportItem) => {
      const storedSession = SessionManagerClass.fetchUserSession();
      const recoveredCrash = isRecoveredCrashItem(item, storedSession?.sessionId);
      const checkedSession = recoveredCrash
        ? null
        : sessionManager.checkSession(classifySessionActivity(item), storedSession);

      let nextItem = item;
      if (checkedSession?.sessionMeta != null && item.meta.session?.id !== checkedSession.sessionId) {
        nextItem = {
          ...item,
          meta: {
            ...item.meta,
            session: checkedSession.sessionMeta,
          },
        };
      }

      const attributes = nextItem.meta.session?.attributes;
      // New crash records carry the crash-time decision. Older records may not,
      // so retain the previous behavior and use the live session's stable
      // decision rather than implicitly sampling every recovered crash.
      const fallbackSamplingDecision = recoveredCrash ? storedSession?.isSampled : checkedSession?.isSampled;
      const samplingAttribute = attributes?.['isSampled'] ?? fallbackSamplingDecision?.toString();

      // Only filter out items when session is explicitly NOT sampled (isSampled='false')
      // If isSampled='true', remove the attribute before sending (it's internal)
      // Fall back to the manager's stable decision when item metadata omits it.
      if (samplingAttribute === 'false') {
        // Session is not sampled - drop this item
        return null;
      }

      if (samplingAttribute === 'true') {
        // Session is sampled - remove internal isSampled attribute before sending
        const newItem: TransportItem = {
          ...nextItem,
          meta: {
            ...nextItem.meta,
            session: nextItem.meta.session
              ? {
                  ...nextItem.meta.session,
                  attributes: nextItem.meta.session.attributes ? { ...nextItem.meta.session.attributes } : undefined,
                }
              : undefined,
          },
        };

        const newAttributes = newItem.meta.session?.attributes;
        delete newAttributes?.['isSampled'];

        if (Object.keys(newAttributes ?? {}).length === 0) {
          delete newItem.meta.session?.attributes;
        }

        return newItem;
      }

      // No isSampled attribute or other value - pass through unchanged
      return nextItem;
    });
  }

  initialize(): void {
    const sessionTrackingConfig = this.config.sessionTracking;

    // A new initialization owns direct-activity routing, including when
    // session tracking is disabled.
    clearDirectSessionActivityHandler();

    if (!sessionTrackingConfig?.enabled) {
      this.metas.addListener(this.sendSessionStartEvent.bind(this));
      return;
    }

    const SessionManagerClass = getSessionManagerByConfig(sessionTrackingConfig);

    // Constructing a manager registers an AppState subscription and a metas
    // listener, so exactly one instance is created and reused. It is also the
    // instance `unpatch()` cleans up.
    this.sessionManagerInstance = new SessionManagerClass();

    this.registerBeforeSendHook(this.sessionManagerInstance, SessionManagerClass);

    const { initialSession, emitSessionStartOnInit } = this.createInitialSession(
      SessionManagerClass,
      sessionTrackingConfig
    );
    SessionManagerClass.storeUserSession(initialSession);

    const initialSessionMeta = initialSession.sessionMeta;
    this.notifiedSession = initialSessionMeta;
    this.api.setSession(initialSessionMeta);

    if (emitSessionStartOnInit) {
      this.api.pushEvent(EVENT_SESSION_START, {}, undefined, { skipDedupe: true });
    }

    this.unregisterDirectSessionActivity = registerDirectSessionActivityHandler(() => {
      this.sessionManagerInstance?.checkSession(SessionActivityKind.Meaningful);
    });

    this.metas.addListener(this.sendSessionStartEvent.bind(this));
  }

  /**
   * Clean up session manager listeners
   */
  unpatch(): void {
    this.unregisterDirectSessionActivity?.();
    this.unregisterDirectSessionActivity = undefined;
    this.sessionManagerInstance?.unpatch();
    this.sessionManagerInstance = undefined;
  }
}
