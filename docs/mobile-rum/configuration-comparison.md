# Configuration Comparison

← [Back to Mobile RUM Comparison](./index.md)

---

## Side-by-Side Configuration

#### **React Native SDK**

Flag-based config: pass flags to `initializeFaro`, `makeRNConfig` builds instrumentations and transports automatically. Aligned with Faro Flutter SDK.

```typescript
import { initializeFaro } from '@grafana/faro-react-native';

initializeFaro({
  // Basic configuration (only app required; url when fetch transport enabled)
  url: 'https://faro-collector.example.com/collect',
  app: {
    name: 'my-mobile-app',
    version: '1.2.3',
    environment: 'production',
  },

  // Transports: enable what to use (makeRNConfig builds them)
  enableTransports: {
    offline: false, // default: false
    fetch: true, // default: true
    console: false, // default: false (for debugging)
  },

  // Performance Monitoring
  cpuUsageVitals: true, // default: true
  memoryUsageVitals: true, // default: true
  refreshRateVitals: false, // default: false
  fetchVitalsInterval: 30000, // default: 30000 (30 seconds)

  // Frame Monitoring (advanced)
  frameMonitoringOptions: {
    targetFps: 60,
    frozenFrameThresholdMs: 100,
    refreshRatePollingInterval: 30000,
    normalizedRefreshRate: 60,
  },

  // Error & Crash Tracking
  enableErrorReporting: true, // default: true
  enableCrashReporting: false, // default: false
  anrTracking: false, // default: false (Android only)
  anrOptions: { timeout: 5000 },

  // Console capture & User actions (optional options via userActionsOptions, consoleCaptureOptions)
  enableConsoleCapture: true, // default: true
  enableUserActions: true, // default: true

  // Network
  ignoreUrls: [/localhost/, /192\.168\./],

  // OpenTelemetry tracing (requires @grafana/faro-react-native-tracing)
  enableTracing: false, // default: false
});
```

**Demo app example** (`demo/src/faro/initialize.ts`):

```typescript
const config: ReactNativeConfig = {
  app: { name: 'react-native-sdk-demo', version: '1.0.0', environment: 'production' },
  url: FARO_COLLECTOR_URL,
  cpuUsageVitals: true,
  memoryUsageVitals: true,
  refreshRateVitals: true,
  fetchVitalsInterval: __DEV__ ? 5000 : 30000,
  enableErrorReporting: true,
  enableCrashReporting: true,
  anrTracking: true,
  enableConsoleCapture: true,
  internalLoggerLevel: __DEV__ ? InternalLoggerLevel.VERBOSE : InternalLoggerLevel.ERROR,
  enableTransports: { offline: true, fetch: true, console: __DEV__ },
  enableTracing: true,
};
const faro = initializeFaro(config);
```

#### **Flutter SDK**

```dart
import 'package:faro/faro.dart';

Faro.initialize(
  optionsConfiguration: FaroConfig(
    // Basic configuration
    url: 'https://faro-collector.example.com/collect',
    appName: 'my-mobile-app',
    appVersion: '1.2.3',
    appEnvironment: 'production',

    // Performance Monitoring
    cpuUsageVitals: true,                         // default: true
    memoryUsageVitals: true,                      // default: true
    refreshRateVitals: false,                     // default: false
    fetchVitalsInterval: Duration(seconds: 30),   // default: 30 seconds

    // Error & Crash Tracking
    enableFlutterErrorReporting: true,            // default: true
    enableCrashReporting: false,                  // default: false

    // Network
    ignoreUrls: ['localhost', '192.168.'],

    // Session
    sessionTracking: true,
  ),
);
```

---

### Configuration Comparison Table

| Option               | React Native                                                     | Flutter                                                            | Notes                                                                                          |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Basic Setup**      |
| URL                  | `url`                                                            | `url`                                                              | Collector endpoint (required when `enableTransports.fetch`)                                    |
| App Name             | `app.name`                                                       | `appName`                                                          | Application name (required)                                                                    |
| App Version          | `app.version`                                                    | `appVersion`                                                       | Version string                                                                                 |
| Environment          | `app.environment`                                                | `appEnvironment`                                                   | Environment identifier                                                                         |
| **Transports**       |
| Offline Cache        | `enableTransports.offline`                                       | Manual: `Faro().transports.add(OfflineTransport(...))` before init | Both: cache when offline. See [Offline Caching](./index.md#offline-caching).                   |
| Fetch                | `enableTransports.fetch`                                         | default                                                            | FetchTransport, requires url                                                                   |
| Console (debug)      | `enableTransports.console`                                       | ❌ No equivalent                                                   | RN: logs to Metro for debugging                                                                |
| **Performance**      |
| CPU Monitoring       | `cpuUsageVitals`                                                 | `cpuUsageVitals`                                                   | Both default: true                                                                             |
| Memory Monitoring    | `memoryUsageVitals`                                              | `memoryUsageVitals`                                                | Both default: true                                                                             |
| Refresh Rate         | `refreshRateVitals`                                              | `refreshRateVitals`                                                | Both default: false                                                                            |
| Sampling Interval    | `fetchVitalsInterval` (ms)                                       | `fetchVitalsInterval` (Duration)                                   | Different types                                                                                |
| Frame Options        | `frameMonitoringOptions` {}                                      | ❌ Not configurable                                                | RN has advanced options                                                                        |
| **Error Tracking**   |
| JS/Dart Errors       | `enableErrorReporting`                                           | `enableFlutterErrorReporting`                                      | Different naming                                                                               |
| Crash Reports        | `enableCrashReporting`                                           | `enableCrashReporting`                                             | Same                                                                                           |
| ANR Detection        | `anrTracking` + `anrOptions`                                     | `anrTracking` (default: false)                                     | Both Android only. RN: configurable timeout; Flutter: fixed 5000ms                             |
| **Console & User**   |
| Console Capture      | `enableConsoleCapture`                                           | ❌ No equivalent                                                   | RN: patches console.\*; Flutter: no print/debugPrint patching                                  |
| Console Options      | `consoleCaptureOptions`                                          | ❌ No equivalent                                                   | RN: disabledLevels, consoleErrorAsLog, serializeErrors                                         |
| User Actions         | `enableUserActions`                                              | Opt-in: wrap app with FaroUserInteractionWidget                    | RN: flag; Flutter: widget wrapper. Both: manual spans/API                                      |
| User Actions Options | `userActionsOptions`                                             | ❌ No equivalent                                                   | RN: dataAttributeName, excludeItem                                                             |
| **Tracing**          |
| OpenTelemetry        | `enableTracing`                                                  | Built-in (always on)                                               | RN: optional; Flutter: FaroTracer, startSpan always available                                  |
| **Network**          |
| URL Filtering        | `ignoreUrls` (RegExp[])                                          | `ignoreUrls` (String[])                                            | Different types                                                                                |
| **User Data**        |
| Persist User         | `initializeUserPersistence()` / `UserPersistence` API            | `persistUser` (default: true)                                      | RN: opt-in AsyncStorage helpers; not a `ReactNativeConfig` flag                                |
| **Session**          |
| Session Sampling     | `sessionTracking.sampling`: `SamplingRate` or `SamplingFunction` | Same idea: `SamplingRate` / `SamplingFunction`                     | Both: per-session sampling; default 100%. See [Session Sampling](./index.md#session-sampling). |

**React Native config model:** Flag-based. Pass `ReactNativeConfig` to `initializeFaro`; `makeRNConfig` builds instrumentations and transports from flags. No manual `getRNInstrumentations` or transport arrays needed.

---
