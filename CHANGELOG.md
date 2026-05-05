# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Register React Native tracing defaults that avoid duplicate fetch/XHR spans,
  filter Metro symbolication requests, and suppress unsupported resource timing
  warnings.

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

[unreleased]: https://github.com/grafana/faro-react-native-sdk/compare/v1.0.0-alpha.1...HEAD
[1.0.0-alpha.1]: https://github.com/grafana/faro-react-native-sdk/releases/tag/v1.0.0-alpha.1
