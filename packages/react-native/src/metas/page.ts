import type { MetaPage } from '@grafana/faro-core';

/**
 * Returns empty page meta for React Native.
 * This overrides the default page meta from faro-core which is web-specific.
 * In React Native, we use view meta for screen tracking instead.
 */
export function getPageMeta() {
  return (): { page?: MetaPage } => ({
    page: {},
  });
}
