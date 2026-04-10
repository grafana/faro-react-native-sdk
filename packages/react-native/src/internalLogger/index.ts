/**
 * Internal logger levels - copied from @grafana/faro-core to avoid bundling web code
 * Keep in sync with @grafana/faro-core's InternalLoggerLevel
 */
export enum InternalLoggerLevel {
  OFF = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  VERBOSE = 4,
}

/**
 * Log levels for console/logging - copied from @grafana/faro-core to avoid bundling web code
 * Keep in sync with @grafana/faro-core's LogLevel
 */
export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  LOG = 'log',
  WARN = 'warn',
  ERROR = 'error',
}

export const defaultLogLevel = LogLevel.LOG;
export const allLogLevels: ReadonlyArray<Readonly<LogLevel>> = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.LOG,
  LogLevel.WARN,
  LogLevel.ERROR,
] as const;
