# Changelog

Release notes for published npm packages are maintained by release-please:

- [`packages/react-native/CHANGELOG.md`](packages/react-native/CHANGELOG.md) —
  `@grafana/faro-react-native`
- [`packages/react-native-tracing/CHANGELOG.md`](packages/react-native-tracing/CHANGELOG.md)
  — `@grafana/faro-react-native-tracing`

The sections below are a historical overview of the monorepo. New releases are
documented in the per-package changelogs above.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [1.1.0] - 2026-05-06

### Added

- `instrumentationOptions.enableFetchInstrumentation` and
  `instrumentationOptions.enableXhrInstrumentation` options on
  `TracingInstrumentation` to control which OpenTelemetry HTTP
  instrumentation is registered.

### Changed

- XHR tracing is now opt-in (`enableXhrInstrumentation` defaults to `false`).
  React Native implements `fetch` on top of XHR, so registering both
  instrumentations produced duplicate spans for the same request. Apps that
  instrument XHR directly (for example some axios setups) should set
  `enableXhrInstrumentation: true`.

### Fixed

- Outbound `fetch`/XHR requests now carry W3C `traceparent` (and
  `tracestate`/`baggage`) headers so client and backend spans join in the
  same trace. `TracingInstrumentation` now registers a global
  `ContextManager` and `TextMapPropagator` instead of relying on the OTel
  noop defaults, which previously prevented header injection.
- Metro dev-server `/symbolicate` requests are no longer traced. Real
  backend `/symbolicate` endpoints are unaffected.
- Suppressed `Deprecated API for given entry type.` warnings by polyfilling
  `performance.getEntriesByType('resource')` to return `[]`. React Native
  does not implement Resource Timing.

## [1.0.0] - 2026-04-15

- Wait until session device attributes are initialized before initializing Faro
  to avoid lost data during initialization

## [1.0.0-alpha.1] - 2026-03-27

First release on npm. This is a **pre-release** (alpha); APIs and behavior
may still change before `1.0.0` stable.

### Added

- Initial release of Faro React Native SDK
- Migrated from faro-web-sdk with full git history (70+ commits)
- Core package (@grafana/faro-react-native) with comprehensive features:
  - Error tracking with stack trace parsing
  - Performance monitoring (CPU and memory via native modules)
  - Console logging instrumentation
  - HTTP request tracking
  - Session management (persistent and volatile)
  - App state monitoring
  - Navigation tracking with React Navigation v6 support
  - User action tracking
  - View instrumentation
  - Native iOS implementation (Swift) for CPU monitoring
  - Native Android implementation (Kotlin) for CPU and memory monitoring
  - Multiple metas: device, page, screen, SDK
  - Fetch and console transports
  - Error boundary components
- Tracing package (@grafana/faro-react-native-tracing) with OpenTelemetry integration:
  - Faro trace exporter
  - Default OTEL instrumentations
  - Instrumentation utilities
  - Faro meta attributes span processor
  - Sampling utilities
- Full-featured demo application showcasing all SDK capabilities
- Comprehensive test coverage (30+ test files)
- TypeScript support with type definitions
- CommonJS and ESM module formats
- Monorepo setup with Yarn Workspaces and Lerna
- GitHub Actions CI/CD workflows
- Documentation (README, FEATURE_PARITY, CONTRIBUTING)

### Changed

- Updated all repository URLs to point to grafana/faro-react-native-sdk
- Set published package versions to `1.0.0-alpha.1` for the first npm pre-release
- Updated @grafana/faro-core dependency to use published npm package (^2.2.3)

[unreleased]: https://github.com/grafana/faro-react-native-sdk/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/grafana/faro-react-native-sdk/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/grafana/faro-react-native-sdk/compare/v1.0.0-alpha.1...v1.0.0
[1.0.0-alpha.1]: https://github.com/grafana/faro-react-native-sdk/releases/tag/v1.0.0-alpha.1
