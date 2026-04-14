import { allLogLevels, BaseInstrumentation, defaultErrorArgsSerializer, LogLevel, VERSION } from '@grafana/faro-core';
import type { LogArgsSerializer } from '@grafana/faro-core';

import { ErrorMechanism } from '../errors/const';

import { getDetailsFromConsoleErrorArgs, reactNativeLogArgsSerializer } from './utils';

/**
 * Console instrumentation for React Native
 * Captures console logs and errors
 *
 * Features:
 * - Configurable log levels
 * - Advanced error serialization
 * - Option to treat console.error as log or error
 * - Unpatch support for cleanup
 */
export class ConsoleInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-console';
  readonly version = VERSION;

  static defaultDisabledLevels: LogLevel[] = [LogLevel.DEBUG, LogLevel.TRACE, LogLevel.LOG];
  static consoleErrorPrefix = 'console.error: ';

  private originalConsole: Partial<Console> = {};
  private errorSerializer: LogArgsSerializer = reactNativeLogArgsSerializer;
  private patchedLevels: LogLevel[] = [];
  private isProcessing = false;

  initialize(): void {
    const instrumentationOptions = this.config.consoleInstrumentation;

    // Configure error serialization
    const serializeErrors = instrumentationOptions?.serializeErrors || !!instrumentationOptions?.errorSerializer;
    this.errorSerializer = serializeErrors
      ? (instrumentationOptions?.errorSerializer ?? defaultErrorArgsSerializer)
      : reactNativeLogArgsSerializer;

    // Store original console methods - use unpatchedConsole from config if available
    // to avoid capturing React Native's patched console (LogBox, DevTools)
    const sourceConsole = this.config.unpatchedConsole ?? console;
    allLogLevels.forEach((level) => {
      this.originalConsole[level] = sourceConsole[level];
    });

    // Determine which levels to patch
    this.patchedLevels = allLogLevels.filter(
      (level) =>
        !(instrumentationOptions?.disabledLevels ?? ConsoleInstrumentation.defaultDisabledLevels).includes(level)
    );

    // Patch console methods
    this.patchedLevels.forEach((level) => {
      console[level] = (...args: unknown[]) => {
        // Prevent re-entry to avoid infinite loops
        if (this.isProcessing) {
          this.originalConsole[level]?.(...args);
          return;
        }

        this.isProcessing = true;
        try {
          if (level === LogLevel.ERROR && !instrumentationOptions?.consoleErrorAsLog) {
            // Handle console.error as an error with advanced serialization
            const { value, type, stackFrames } = getDetailsFromConsoleErrorArgs(args, this.errorSerializer);

            const context = { mechanism: ErrorMechanism.CONSOLE };

            if (value && !type && !stackFrames) {
              // Simple error without stack frames
              this.api.pushError(new Error(ConsoleInstrumentation.consoleErrorPrefix + value), { context });
            } else {
              // Error with type and/or stack frames (type from error.name, matches Web SDK)
              this.api.pushError(new Error(ConsoleInstrumentation.consoleErrorPrefix + (value ?? '')), {
                context,
                type,
                stackFrames,
              });
            }
          } else if (level === LogLevel.ERROR && instrumentationOptions?.consoleErrorAsLog) {
            // Handle console.error as a log with error details in context
            const { value, type, stackFrames } = getDetailsFromConsoleErrorArgs(args, this.errorSerializer);

            this.api.pushLog(value ? [ConsoleInstrumentation.consoleErrorPrefix + value] : args, {
              level,
              context: {
                value: value ?? '',
                type: type ?? '',
                stackFrames: stackFrames?.length ? defaultErrorArgsSerializer(stackFrames) : '',
              },
            });
          } else {
            // Handle other log levels normally
            this.api.pushLog(args, { level });
          }
        } catch (_err) {
          // Silently ignore errors to prevent infinite loops during bootstrap
        } finally {
          // Always call original console method (still protected by isProcessing flag)
          this.originalConsole[level]?.(...args);
          this.isProcessing = false;
        }
      };
    });
  }

  /**
   * Restore original console methods
   * Call this to clean up and unpatch the console
   */
  unpatch(): void {
    this.patchedLevels.forEach((level) => {
      if (this.originalConsole[level]) {
        console[level] = this.originalConsole[level];
      }
    });

    this.patchedLevels = [];
  }
}
