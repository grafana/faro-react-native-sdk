import type { TransportItem } from '@grafana/faro-core';

import { omitDynamicDeviceFields } from '../../metas/dynamicDeviceState';
import { DYNAMIC_SESSION_ATTRIBUTE_KEYS } from '../session/sessionAttributes';

/**
 * Returns a copy of `item` without the device and network values that belong to the current
 * process. A crash sent on the next launch describes the crashed process, and no dynamic value was
 * saved with it, so the relaunch's battery, power and network state must not stand in for it.
 */
export function omitRelaunchDeviceState(item: TransportItem): TransportItem {
  const { device, network: _network, ...meta } = item.meta as TransportItem['meta'] & { network?: unknown };
  const attributes = item.meta.session?.attributes;

  return {
    ...item,
    meta: {
      ...meta,
      ...(device ? { device: omitDynamicDeviceFields(device) } : {}),
      ...(item.meta.session && attributes
        ? {
            session: {
              ...item.meta.session,
              attributes: Object.fromEntries(
                Object.entries(attributes).filter(
                  ([key]) => !(DYNAMIC_SESSION_ATTRIBUTE_KEYS as readonly string[]).includes(key)
                )
              ),
            },
          }
        : {}),
    },
  };
}
