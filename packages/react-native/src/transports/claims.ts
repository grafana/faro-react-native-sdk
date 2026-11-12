import type { TransportItem } from '@grafana/faro-core';

/**
 * Items an `OfflineTransport` cached for later replay. Faro hands every item to
 * every transport in one synchronous loop, so the offline transport claims an
 * item before a network transport looks at it. Network transports skip claimed
 * items in their live `send()`, so the item is delivered once, by replay.
 */
const claimedItems = new WeakSet<object>();

export function claimForOfflineReplay(items: TransportItem[]): void {
  for (const item of items) {
    if (typeof item === 'object' && item !== null) {
      claimedItems.add(item);
    }
  }
}

export function isClaimedForOfflineReplay(item: TransportItem): boolean {
  return typeof item === 'object' && item !== null && claimedItems.has(item);
}
