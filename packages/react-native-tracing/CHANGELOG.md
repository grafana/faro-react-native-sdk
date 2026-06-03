# Changelog

## [1.2.1](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.2.0...faro-react-native-tracing-v1.2.1) (2026-06-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @grafana/faro-react-native bumped to 1.2.1

## [1.2.0](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.1.0...faro-react-native-tracing-v1.2.0) (2026-05-26)

### Features

- configure release please to manage release of both packages ([6ccb29f](https://github.com/grafana/faro-react-native-sdk/commit/6ccb29ff5010887ec2516fd8f0e75a800b806b0d))
- configure release please to manage release of both packages ([71d6ac1](https://github.com/grafana/faro-react-native-sdk/commit/71d6ac13813e5c6c34271aeb2fa468beedb6021d))

### Bug Fixes

- lint errors ([883cb12](https://github.com/grafana/faro-react-native-sdk/commit/883cb12822ea369b419222dd24dc25c817498dde))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped to 1.2.0

## [1.1.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-tracing-v1.0.0...react-native-tracing-v1.1.0) (2026-05-06)

### Features

- add `instrumentationOptions.enableFetchInstrumentation` and `instrumentationOptions.enableXhrInstrumentation` on `TracingInstrumentation`

### Bug Fixes

- outbound fetch/XHR requests now carry W3C trace context headers via a registered `ContextManager` and `TextMapPropagator`
- Metro dev-server `/symbolicate` requests are no longer traced
- suppress Resource Timing deprecation warnings with a `performance.getEntriesByType('resource')` polyfill

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped from ^1.0.0 to ^1.1.0

## [1.0.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-tracing-v1.0.0-alpha.1...react-native-tracing-v1.0.0) (2026-04-15)

### Features

- initial stable release of `@grafana/faro-react-native-tracing` with OpenTelemetry integration

## [1.0.0-alpha.1](https://github.com/grafana/faro-react-native-sdk/releases/tag/react-native-tracing-v1.0.0-alpha.1) (2026-03-27)

### Features

- initial release of `@grafana/faro-react-native-tracing` with Faro trace exporter, default OTEL instrumentations, and span processors
