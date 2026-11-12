import type { TransportItem } from '@grafana/faro-core';

/**
 * Splits items into groups that share the same meta, keeping the first-seen
 * order of groups and the original order of items within each group. A request
 * carries one meta block, so each group is sent as its own request.
 */
export function groupItemsByMeta(items: TransportItem[]): TransportItem[][] {
  const groups = new Map<string, TransportItem[]>();
  for (const item of items) {
    const key = JSON.stringify(item.meta);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return Array.from(groups.values());
}

/**
 * Splits items into runs of consecutive items that share the same meta, keeping
 * the original order: metas `A, B, A` give three runs. The offline cache uses
 * it so replay keeps capture order.
 */
export function groupContiguousItemsByMeta(items: TransportItem[]): TransportItem[][] {
  const runs: TransportItem[][] = [];
  let lastKey: string | undefined;
  let current: TransportItem[] | undefined;
  for (const item of items) {
    const key = JSON.stringify(item.meta);
    if (current === undefined || key !== lastKey) {
      current = [item];
      runs.push(current);
      lastKey = key;
    } else {
      current.push(item);
    }
  }
  return runs;
}
