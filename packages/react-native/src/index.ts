// Main entry point for @grafana/faro-react-native
export { initializeFaro } from './initialize';
export { faro } from '@grafana/faro-core';

// Export types
export type { EnableTransportsConfig, ReactNativeConfig } from './config/types';

// Export instrumentation helpers
export { getRNInstrumentations } from './config/getRNInstrumentations';

// Export instrumentations
export { ErrorMechanism, ErrorsInstrumentation } from './instrumentations/errors';
export type { ErrorMechanismType, ErrorsInstrumentationOptions } from './instrumentations/errors';
export { ConsoleInstrumentation } from './instrumentations/console';
export { SessionInstrumentation } from './instrumentations/session';
export { ViewInstrumentation } from './instrumentations/view';
export { AppStateInstrumentation } from './instrumentations/appState';
export { UserActionInstrumentation } from './instrumentations/userActions';
export { HttpInstrumentation } from './instrumentations/http';
export { XHRInstrumentation } from './instrumentations/xhr';
export { PerformanceInstrumentation } from './instrumentations/performance';
export type { PerformanceInstrumentationOptions } from './instrumentations/performance/types';
export { StartupInstrumentation } from './instrumentations/startup';
export type { StartupInstrumentationOptions } from './instrumentations/startup/types';
export { FrameMonitoringInstrumentation } from './instrumentations/frameMonitoring';
export type { FrameMonitoringOptions } from './instrumentations/frameMonitoring';
export { ANRInstrumentation } from './instrumentations/anr';
export type { ANRInstrumentationOptions } from './instrumentations/anr';
export { CrashReportingInstrumentation } from './instrumentations/crashReporting';
export type { CrashReportingOptions } from './instrumentations/crashReporting';

// Export console utilities
export { reactNativeLogArgsSerializer } from './instrumentations/console/utils';

// Export user action helpers
export {
  withFaroUserAction,
  trackUserAction,
  type WithFaroUserActionProps,
} from './instrumentations/userActions/withFaroUserAction';
export { notifyHttpRequestEnd, notifyHttpRequestStart } from './instrumentations/userActions/httpRequestMonitor';
export type { HttpRequestMessagePayload } from './instrumentations/userActions/httpRequestMonitor';

// Export error boundary
export { FaroErrorBoundary } from './errorBoundary/FaroErrorBoundary';
export { withFaroErrorBoundary } from './errorBoundary/withFaroErrorBoundary';
export type {
  FaroErrorBoundaryProps,
  FaroErrorBoundaryState,
  FaroErrorBoundaryFallbackRender,
} from './errorBoundary/types';

// Export metas
export { getPageMeta } from './metas/page';
export { getScreenMeta } from './metas/screen';
export { getSdkMeta } from './metas/sdk';

// Export transports
export { FetchTransport } from './transports/fetch';
export { ConsoleTransport } from './transports/console';
export type { ConsoleTransportOptions } from './transports/console';
export { OfflineTransport } from './transports/offline';
export type { OfflineTransportOptions } from './transports/offline';

// Export data collection policy
export {
  createDataCollectionPolicy,
  getDataCollectionPolicy,
  initializeDataCollectionPolicy,
  setDataCollectionPolicy,
} from './dataCollection';
export type { DataCollectionPolicy, DataCollectionPolicyOptions } from './dataCollection';

// Export user persistence
export {
  createUserPersistence,
  getUserPersistence,
  initializeUserPersistence,
  setUserPersistence,
} from './userPersistence';
export type { UserPersistence, UserPersistenceOptions } from './userPersistence';

// Export navigation utilities
export { ReactNativeNavigationIntegration } from './navigation/v6';
export {
  useFaroNavigation,
  createNavigationStateChangeHandler,
  getCurrentRoute,
  getRouteName,
  onNavigationStateChange,
} from './navigation';
export type { ReactNavigationDependencies, ReactNavigationConfig } from './navigation/types';

// Re-export core types and enums that consumers will need
export type {
  Config,
  Faro,
  Instrumentation,
  Meta,
  Transport,
  PushErrorOptions,
  PushEventOptions,
  PushLogOptions,
  PushMeasurementOptions,
} from '@grafana/faro-core';

// Export LogLevel enum (not just the type)
export { LogLevel } from '@grafana/faro-core';
