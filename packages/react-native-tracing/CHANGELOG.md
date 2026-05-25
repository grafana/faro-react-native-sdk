# Changelog

## [1.1.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-tracing-v1.0.0...react-native-tracing-v1.1.0) (2026-05-06)

### Features

* add `instrumentationOptions.enableFetchInstrumentation` and `instrumentationOptions.enableXhrInstrumentation` on `TracingInstrumentation`

### Bug Fixes

* outbound fetch/XHR requests now carry W3C trace context headers via a registered `ContextManager` and `TextMapPropagator`
* Metro dev-server `/symbolicate` requests are no longer traced
* suppress Resource Timing deprecation warnings with a `performance.getEntriesByType('resource')` polyfill

### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @grafana/faro-react-native bumped from ^1.0.0 to ^1.1.0

## [1.0.0](https://github.com/grafana/faro-react-native-sdk/compare/react-native-tracing-v1.0.0-alpha.1...react-native-tracing-v1.0.0) (2026-04-15)

### Features

* initial stable release of `@grafana/faro-react-native-tracing` with OpenTelemetry integration

## [1.0.0-alpha.1](https://github.com/grafana/faro-react-native-sdk/releases/tag/react-native-tracing-v1.0.0-alpha.1) (2026-03-27)

### Features

* initial release of `@grafana/faro-react-native-tracing` with Faro trace exporter, default OTEL instrumentations, and span processors
