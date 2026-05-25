# Changelog

## [Unreleased]

### Features

* Hermes / minified JavaScript error symbolication: optional `releaseBundleFilename` config, Hermes-oriented stack trace normalization, and `meta.app.bundleId` from the Metro preamble via `@grafana/faro-core` `getBundleId` ([#40](https://github.com/grafana/faro-react-native-sdk/pull/40))
* Autolinked composed source map upload on Android and iOS Release builds via `@grafana/faro-metro-plugin`; uploads skip gracefully when env vars or the upload shim are missing ([#40](https://github.com/grafana/faro-react-native-sdk/pull/40))

### Bug Fixes

* normalize Hermes bundle paths and load Xcode env before composed map upload ([#40](https://github.com/grafana/faro-react-native-sdk/pull/40))
* gate Android upload on bundle success and load Xcode env before `FARO_*` checks ([#40](https://github.com/grafana/faro-react-native-sdk/pull/40))

## [1.1.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-v1.0.0...react-native-v1.1.0) (2026-05-06)

## [1.0.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-v1.0.0-alpha.1...react-native-v1.0.0) (2026-04-15)

### Bug Fixes

* wait until session device attributes are initialized before initializing Faro to avoid lost data during initialization

## [1.0.0-alpha.1](https://github.com/grafana/faro-react-native-sdk/releases/tag/react-native-v1.0.0-alpha.1) (2026-03-27)

### Features

* initial release of `@grafana/faro-react-native` with error tracking, performance monitoring, session management, navigation tracking, user actions, native iOS/Android modules, and transports
