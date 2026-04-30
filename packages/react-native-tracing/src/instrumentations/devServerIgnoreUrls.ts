import type { MatchUrlDefinitions } from '../types';

const REACT_NATIVE_DEV_SERVER_IGNORE_URLS: MatchUrlDefinitions = [
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)(?::\d+)?\/symbolicate(?:[/?#]|$)/,
];

export function getReactNativeDevServerIgnoreUrls(): MatchUrlDefinitions {
  return REACT_NATIVE_DEV_SERVER_IGNORE_URLS;
}
