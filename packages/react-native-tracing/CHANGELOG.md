# Changelog

## Unreleased

### Breaking Changes

- Fetch spans use stable HTTP conventions only. Update queries from `HTTP GET` / `HTTP POST`
  to `GET` / `POST`, and replace `http.method`, `http.url`, and `http.status_code` with
  `http.request.method`, `url.full`, and `http.response.status_code`. Faro fetch event
  fields stay unchanged; there is no legacy span mode.

### Bug Fixes

- Correct HTTP request timing and capture the active user action before request monitoring halts it.

## [2.0.1](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v2.0.0...faro-react-native-tracing-v2.0.1) (2026-09-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @grafana/faro-react-native bumped to 1.4.1

## [2.0.0](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.3.1...faro-react-native-tracing-v2.0.0) (2026-09-24)

### ⚠ BREAKING CHANGES

- **tracing:** Fetch spans use stable OpenTelemetry HTTP names and attributes only. Update legacy span queries; no legacy fetch mode is available.

### Features

- **tracing:** adopt stable HTTP spans with compatible Faro events ([#196](https://github.com/grafana/faro-react-native-sdk/issues/196)) ([a6e78a9](https://github.com/grafana/faro-react-native-sdk/commit/a6e78a9dd9009693f11010633d012761f36d60f3))

### Bug Fixes

- **tracing:** clean up instrumentation on removal ([5ecfa70](https://github.com/grafana/faro-react-native-sdk/commit/5ecfa701c4e3bbd3dd55573d1cf7d592334d7186))
- **tracing:** clean up instrumentation on removal ([f9357d4](https://github.com/grafana/faro-react-native-sdk/commit/f9357d43fd6f36decb7a1191aa10a13e670f062a))
- **tracing:** preserve reusable OpenTelemetry components ([4122984](https://github.com/grafana/faro-react-native-sdk/commit/4122984b2ed41957fdaf8fcb55d6409a19af263e))
- **tracing:** reject duplicate global provider ([cb8b9a0](https://github.com/grafana/faro-react-native-sdk/commit/cb8b9a0453f8e9c76350b56db7684b0ce7463f09))
- **tracing:** reuse default request instrumentations ([6fd3f4b](https://github.com/grafana/faro-react-native-sdk/commit/6fd3f4b333d707cf25d565cb530a2ff86ebabd57))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped to 1.4.0

## [1.3.1](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.3.0...faro-react-native-tracing-v1.3.1) (2026-07-15)

### Bug Fixes

- **deps:** remediate dependency vulnerabilities ([#124](https://github.com/grafana/faro-react-native-sdk/issues/124)) ([bb81fdc](https://github.com/grafana/faro-react-native-sdk/commit/bb81fdc610349bdfd51b423a031023dc64983a2c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped to 1.3.1

## [1.3.0](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.2.1...faro-react-native-tracing-v1.3.0) (2026-06-30)

### Features

- **react-native:** populate structured mobile meta fields ([271bcad](https://github.com/grafana/faro-react-native-sdk/commit/271bcad1aa341b5b1af0eeca396dfd8cf9f87246))
- **react-native:** populate structured mobile meta fields ([88082e0](https://github.com/grafana/faro-react-native-sdk/commit/88082e00c91357fb658d400358f1ca90bf4da427))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped to 1.3.0

## [1.2.1](https://github.com/grafana/faro-react-native-sdk/compare/faro-react-native-tracing-v1.2.0...faro-react-native-tracing-v1.2.1) (2026-06-03)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @grafana/faro-react-native bumped to 1.2.1

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
