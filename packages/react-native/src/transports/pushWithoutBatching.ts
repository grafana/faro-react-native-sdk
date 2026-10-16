import { TransportItemType } from '@grafana/faro-core';
import type { Config, TransportItem, Transports } from '@grafana/faro-core';

import { captureSessionItem } from '../instrumentations/session/sessionCapture';

/**
 * Runs `push` so the telemetry it pushes is sent to every transport now
 * instead of waiting in the batch queue, such as for a fatal error after which
 * the app may exit before the next flush. Items go through session capture and
 * the beforeSend hooks once, as when batching is disabled. Without batching,
 * `push` runs unchanged.
 */
export function pushWithoutBatching(transports: Transports, config: Config, push: () => void): void {
  if (!config.batching?.enabled) {
    push();
    return;
  }

  const execute = transports.execute;
  transports.execute = (item) => sendNow(transports, config, item);
  try {
    push();
  } finally {
    transports.execute = execute;
  }
}

function sendNow(transports: Transports, config: Config, item: TransportItem): void {
  if (transports.isPaused()) {
    return;
  }

  let filteredItem = captureSessionItem(transports, item);
  for (const hook of transports.getBeforeSendHooks()) {
    if (filteredItem == null) {
      return;
    }
    filteredItem = hook(filteredItem);
  }
  if (filteredItem == null) {
    return;
  }

  // Match faro-core, which removes the original error after the hooks when it is preserved for them.
  if (config.preserveOriginalError && filteredItem.type === TransportItemType.EXCEPTION) {
    delete (filteredItem.payload as { originalError?: unknown }).originalError;
  }

  for (const transport of transports.transports) {
    if (transport.isBatched()) {
      transport.send([filteredItem]);
    } else {
      transport.send(filteredItem);
    }
  }
}
