# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-01-23

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
- Set package versions to 1.0.0 for initial standalone release
- Updated @grafana/faro-core dependency to use published npm package (^2.1.0)

[unreleased]: https://github.com/grafana/faro-react-native-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/grafana/faro-react-native-sdk/releases/tag/v1.0.0
