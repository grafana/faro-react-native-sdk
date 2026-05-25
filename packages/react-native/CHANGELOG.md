# Changelog

## [Unreleased]

### Added

- Hermes release error symbolication: new `releaseBundleFilename` config option
  (must match the Metro plugin source map top-level `file`, e.g.
  `index.android.bundle` or `main.jsbundle`) so error stack frames align with
  uploaded composed maps in Grafana Frontend Observability.
- `meta.app.bundleId` on outgoing payloads via `@grafana/faro-core`
  `getBundleId()` and the Faro bundle id preamble injected at Metro bundle
  time by `@grafana/faro-metro-plugin` (same id as `FARO_BUNDLE_ID` at upload).
- Autolinked composed Hermes source map upload on Android release
  (`faroUploadComposedSourceMapAndroidRelease`) and iOS Release (Xcode build
  phase `[Faro] Upload composed source map (Release)`), invoking
  `@grafana/faro-metro-plugin` when `FARO_BUNDLE_ID` and `FARO_SOURCEMAP_*`
  env vars are set; use `FARO_SKIP_SOURCEMAP_UPLOAD=1` to skip.
- README section documenting the end-to-end symbolication flow (Metro →
  release upload → `meta.app.bundleId` → readable stacks in Grafana).

### Changed

- Error stack trace parsing now normalizes Hermes/minified release frame
  `filename` values to the configured release bundle basename instead of
  verbose Hermes labels, matching ingest source map lookup.

### Fixed

- Android composed source map upload runs only after the release bundle task
  succeeds.
- iOS upload script loads `ios/.xcode.env` / `.xcode.env.local` before
  checking `FARO_*` env vars so Xcode-local configuration is picked up.

### Security

- Added root `.npmrc` and `.yarnrc` to disable package lifecycle scripts when
  npm or Yarn Classic is used, complementing existing Yarn Berry
  `enableScripts: false` configuration.

## [1.1.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-v1.0.0...react-native-v1.1.0) (2026-05-06)

Released in sync with `@grafana/faro-react-native-tracing@1.1.0` (tracing fixes and W3C propagation landed in the tracing package).

### Bug Fixes

* apply Resource Timing polyfill on all platforms — polyfill `performance.getEntriesByType('resource')` to return `[]` and suppress `Deprecated API for given entry type` warnings on React Native ([#34](https://github.com/grafana/faro-react-native-sdk/pull/34))

### Documentation

* document default `tracingOptions.instrumentationOptions.enableXhrInstrumentation: false` in the README initialization example ([#34](https://github.com/grafana/faro-react-native-sdk/pull/34))

## [1.0.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-v1.0.0-alpha.1...react-native-v1.0.0) (2026-04-15)

### Bug Fixes

* wait until session device attributes are initialized before initializing Faro to avoid lost data during initialization

## [1.0.0-alpha.1](https://github.com/grafana/faro-react-native-sdk/releases/tag/react-native-v1.0.0-alpha.1) (2026-03-27)

### Features

* initial release of `@grafana/faro-react-native` with error tracking, performance monitoring, session management, navigation tracking, user actions, native iOS/Android modules, and transports
