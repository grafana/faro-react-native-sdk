import { defaultUnpatchedConsole, noop, VERSION } from '@grafana/faro-core';
import type {
  Config,
  InternalLogger,
  Metas,
  Patterns,
  Transport,
  TransportItem,
  UnpatchedConsole,
} from '@grafana/faro-core';

export class MockTransport implements Transport {
  readonly name = '@grafana/transport-mock';
  readonly version = VERSION;

  unpatchedConsole: UnpatchedConsole = defaultUnpatchedConsole;
  internalLogger: InternalLogger = {
    debug: noop,
    error: noop,
    info: noop,
    prefix: '@grafana/transport-mock',
    warn: noop,
  };
  config: Config = {} as Config;
  metas: Metas = {} as Metas;

  items: TransportItem[] = [];

  constructor(private ignoreURLs: Patterns = []) {}

  send(items: TransportItem | TransportItem[]): void | Promise<void> {
    this.items.push(...(Array.isArray(items) ? items : [items]));
  }

  isBatched(): boolean {
    return true;
  }

  getIgnoreUrls(): Patterns {
    return this.ignoreURLs;
  }

  logDebug(...args: unknown[]): void {
    this.internalLogger.debug(`${this.name}\n`, ...args);
  }

  logInfo(...args: unknown[]): void {
    this.internalLogger.info(`${this.name}\n`, ...args);
  }

  logWarn(...args: unknown[]): void {
    this.internalLogger.warn(`${this.name}\n`, ...args);
  }

  logError(...args: unknown[]): void {
    this.internalLogger.error(`${this.name}\n`, ...args);
  }
}
