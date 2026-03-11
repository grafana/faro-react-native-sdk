import { faro } from '@grafana/faro-core';

import type { ReactNativeSessionTrackingConfig } from '../../../config/types';

export function isSampled(): boolean {
  const sendAllSignals = 1;
  const sessionTracking = faro.config.sessionTracking as ReactNativeSessionTrackingConfig | undefined;

  const samplingRate = sessionTracking?.sampling
    ? sessionTracking.sampling.resolve({ meta: faro.metas.value })
    : sendAllSignals;

  return Math.random() < samplingRate;
}
