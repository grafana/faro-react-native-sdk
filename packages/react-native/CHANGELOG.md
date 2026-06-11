# Changelog

## [1.3.0](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-v1.2.1...faro-react-native-v1.3.0) (2026-06-11)

### Features

- **react-native:** align structured mobile meta ([39ac76b](https://github.com/grafana/faro-react-native-sdk/commit/39ac76b5cceb4c87fe8a9f148a6b1762ebb33b68))
- **react-native:** populate structured mobile meta fields ([271bcad](https://github.com/grafana/faro-react-native-sdk/commit/271bcad1aa341b5b1af0eeca396dfd8cf9f87246))
- **react-native:** populate structured mobile meta fields ([88082e0](https://github.com/grafana/faro-react-native-sdk/commit/88082e00c91357fb658d400358f1ca90bf4da427))

## [1.2.1](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-v1.2.0...faro-react-native-v1.2.1) (2026-06-03)

### Bug Fixes

- **react-native:** capture real exit code in iOS source map upload warning ([cd1e199](https://github.com/grafana/faro-react-native-sdk/commit/cd1e1999feaed171ad1ae6b783c7e21f810be979))
- **react-native:** do not fail iOS Release build on source map upload errors ([6373026](https://github.com/grafana/faro-react-native-sdk/commit/637302606e8e113b7f6f68a06f1ae20b49731004))
- **react-native:** do not fail iOS Release build on source map upload errors ([a8f2cdc](https://github.com/grafana/faro-react-native-sdk/commit/a8f2cdc638e5c38f7eff774e2e512b01ef07afa6))

## [1.2.0](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-v1.1.0...faro-react-native-v1.2.0) (2026-05-26)

### Features

- add js hermes simbolification support for RN ([d6ded03](https://github.com/grafana/faro-react-native-sdk/commit/d6ded03e157b417669923ec59324c35c9ae0ff49))
- configure release please to manage release of both packages ([6ccb29f](https://github.com/grafana/faro-react-native-sdk/commit/6ccb29ff5010887ec2516fd8f0e75a800b806b0d))
- configure release please to manage release of both packages ([71d6ac1](https://github.com/grafana/faro-react-native-sdk/commit/71d6ac13813e5c6c34271aeb2fa468beedb6021d))
- **react-native:** autolink Hermes composed source map upload on Android and iOS ([d74342b](https://github.com/grafana/faro-react-native-sdk/commit/d74342b2de863f8a0e5b3630aaf5b9740a1dbbf1))
- **react-native:** Hermes JS symbolication and autolinked composed source map upload ([81582e1](https://github.com/grafana/faro-react-native-sdk/commit/81582e1c2c644cfaa6fca00d540f7126793ee216))

### Bug Fixes

- lint ([6ad07cc](https://github.com/grafana/faro-react-native-sdk/commit/6ad07ccb6e8feb9359aa2a3c06f6e3571c301fb9))
- lint errors ([883cb12](https://github.com/grafana/faro-react-native-sdk/commit/883cb12822ea369b419222dd24dc25c817498dde))
- **react-native:** gate Android upload on bundle success and load Xcode env before FARO\_\* checks ([252e7a5](https://github.com/grafana/faro-react-native-sdk/commit/252e7a5869fa5d34faa7bce968b6969b18f8a00d))
- **react-native:** normalize Hermes bundle paths and load Xcode env before map upload ([cd60f41](https://github.com/grafana/faro-react-native-sdk/commit/cd60f41faa7648c6ddb726889fab07669bf59b89))
- remove circular optional peer-dep on tracing ([2e779ae](https://github.com/grafana/faro-react-native-sdk/commit/2e779ae9ef1266c7a7e8b0d07d830ced0709c7dd))
- unblock release-please by breaking workspace dep cycle ([7bf8106](https://github.com/grafana/faro-react-native-sdk/commit/7bf8106eb44b998b75217a8beb01b56d0a011b57))
- update changelog description for each version already released with no data ([3a8d2aa](https://github.com/grafana/faro-react-native-sdk/commit/3a8d2aadb0d96b7a69a2f56aa42beb4eb7f27908))

## [Unreleased]

### Added

- Structured mobile payload fields: `meta.device`, `meta.os`,
  `meta.app.installationId`, and `exception.fatal`. Legacy flat
  `session.attributes` device/OS fields are still emitted during migration.
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

- apply Resource Timing polyfill on all platforms — polyfill `performance.getEntriesByType('resource')` to return `[]` and suppress `Deprecated API for given entry type` warnings on React Native ([#34](https://github.com/grafana/faro-react-native-sdk/pull/34))

### Documentation

- document default `tracingOptions.instrumentationOptions.enableXhrInstrumentation: false` in the README initialization example ([#34](https://github.com/grafana/faro-react-native-sdk/pull/34))

## [1.0.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-v1.0.0-alpha.1...react-native-v1.0.0) (2026-04-15)

### Bug Fixes

- wait until session device attributes are initialized before initializing Faro to avoid lost data during initialization

## [1.0.0-alpha.1](https://github.com/grafana/faro-react-native-sdk/releases/tag/react-native-v1.0.0-alpha.1) (2026-03-27)

### Features

- initial release of `@grafana/faro-react-native` with error tracking, performance monitoring, session management, navigation tracking, user actions, native iOS/Android modules, and transports
