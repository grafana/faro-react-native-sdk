# Mobile RUM: React Native & Flutter SDK Comparison

## Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [CPU & Memory Metrics](#cpu--memory-metrics)
  - [Refresh Rate & Frame Monitoring](#refresh-rate--frame-monitoring)
  - [Startup Time Metrics](#startup-time-metrics)
  - [HTTP Instrumentation](#http-instrumentation)
  - [Crash Reporting](#crash-reporting)
  - [ANR Detection](#anr-detection)
  - [App State](#app-state)
  - [Console Capture](#console-capture)
  - [Error Reporting](#error-reporting)
  - [Session Management](#session-management)
  - [Session Sampling](#session-sampling)
  - [User Actions](#user-actions)
  - [View / Screen Tracking](#view--screen-tracking)
  - [Offline Caching](#offline-caching)
- [Configuration Comparison](./configuration-comparison.md)
- [Reference Documents](#reference-documents)
  - [Threshold Proposals](./threshold-proposals.md)
  - [Real Log Examples](./real-log-examples.md)
  - [Feature Parity Matrix](./feature-parity-matrix.md)

---

## Overview

This document provides a comprehensive comparison between the Faro React Native SDK and Faro Flutter SDK, including metric formats, configuration options, implementation details, and real-world examples.

Both SDKs aim for feature parity with mobile-specific instrumentation for:

- Performance monitoring (CPU, Memory, Frame rates)
- Application lifecycle tracking
- Crash and error reporting
- Network monitoring
- User session tracking

**React Native SDK:** Uses a flag-based configuration. Pass `ReactNativeConfig` (with `app`, `url`, and feature flags) to `initializeFaro`. The internal `makeRNConfig` builds instrumentations and transports from these flags—aligned with the Faro Flutter SDK pattern. See `demo/src/faro/initialize.ts` for a full example.

---

## Features

### CPU & Memory Metrics

#### How Data is Collected

##### **React Native SDK**

**iOS Implementation:**

- **CPU**: Per-process calculation using `task_threads()` + `thread_info()`
  - Enumerates all threads and sums CPU time (user + system)
  - Differential calculation: `(cpuTimeDelta / wallTimeDelta) * 100`
  - First call returns 0 (baseline)
- **Memory**: `task_info()` with `TASK_VM_INFO`
  - Uses `phys_footprint` metric (Apple-recommended)
  - Returns physical memory in kilobytes

**Android Implementation:**

- **CPU**: Parses `/proc/[pid]/stat`
  - Reads `utime`, `stime`, `cutime`, `cstime` fields
  - Differential calculation with clock speed normalization
  - Requires API 21+ (Lollipop)
- **Memory**: Parses `/proc/[pid]/status`
  - Extracts `VmRSS` (Virtual Memory Resident Set Size)
  - Returns memory in kilobytes

##### **Flutter SDK**

**iOS Implementation:**

- **CPU**: System-wide calculation using `host_statistics()`
  - ⚠️ **Known Bug**: Uses system-wide CPU instead of per-process
  - Results in incorrect percentages on multi-core devices
- **Memory**: `task_info()` with `TASK_VM_INFO`
  - Uses `resident_size` metric (older, less accurate than `phys_footprint`)
  - Returns memory in bytes (raw)

**Android Implementation:**

- **CPU**: Identical to React Native (`/proc/[pid]/stat`)
- **Memory**: Identical to React Native (`/proc/[pid]/status` VmRSS)

---

#### Metric Format Sent to Faro

##### **React Native SDK**

**Memory Measurement:**

```json
{
  "type": "app_memory",
  "values": {
    "mem_usage": 123456.78
  }
}
```

- Unit: Kilobytes (KB)
- Sent when: Every `fetchVitalsInterval` (default 30s)
- Filtering: Skips null or ≤ 0 values

**CPU Measurement:**

```json
{
  "type": "app_cpu_usage",
  "values": {
    "cpu_usage": 45.67
  }
}
```

- Unit: Percentage (0-100+, can exceed 100% on multi-core)
- Sent when: Every `fetchVitalsInterval` (default 30s)
- Filtering: Skips null, negative, or 0 values (first baseline call)

##### **Flutter SDK**

**Memory Measurement:**

```json
{
  "type": "app_memory",
  "values": {
    "mem_usage": 123456.0
  }
}
```

- Unit: iOS bytes, Android kilobytes
- Filtering: Only sends values > 0.0

**CPU Measurement:**

```json
{
  "type": "app_cpu_usage",
  "values": {
    "cpu_usage": 45.67
  }
}
```

- Filtering: Only sends values > 0.0 AND < 100.0
- ⚠️ Filters out legitimate >100% values on multi-core systems

---

#### Configuration

##### **React Native SDK**

```typescript
import { initializeFaro } from '@grafana/faro-react-native';

initializeFaro({
  url: 'https://your-collector.com',
  app: {
    name: 'my-app',
    version: '1.0.0',
  },
  // CPU & Memory monitoring (flag-based: makeRNConfig builds instrumentations)
  cpuUsageVitals: true, // default: true
  memoryUsageVitals: true, // default: true
  fetchVitalsInterval: 30000, // default: 30000 (30 seconds)
});
```

**Configuration Options:**

- `cpuUsageVitals`: Enable/disable CPU monitoring
- `memoryUsageVitals`: Enable/disable memory monitoring
- `fetchVitalsInterval`: Sampling interval in milliseconds

**Note:** Uses flag-based config; `makeRNConfig` builds instrumentations and transports from these flags (aligned with Faro Flutter SDK).

##### **Flutter SDK**

```dart
import 'package:faro/faro.dart';

Faro.initialize(
  optionsConfiguration: FaroConfig(
    url: 'https://your-collector.com',

    // CPU & Memory monitoring
    cpuUsageVitals: true,                         // default: true
    memoryUsageVitals: true,                      // default: true
    fetchVitalsInterval: Duration(seconds: 30),   // default: 30 seconds
  ),
);
```

**Configuration Options:**

- `cpuUsageVitals`: Enable/disable CPU monitoring
- `memoryUsageVitals`: Enable/disable memory monitoring
- `fetchVitalsInterval`: Sampling interval as Duration object

---

#### Key Differences

| Aspect                | React Native                            | Flutter                     |
| --------------------- | --------------------------------------- | --------------------------- |
| **Default Enabled**   | ✅ Both true                            | ✅ Both true                |
| **iOS CPU Method**    | ✅ Per-process (accurate)               | ⚠️ System-wide (inaccurate) |
| **iOS Memory Metric** | ✅ `phys_footprint` (Apple-recommended) | ⚠️ `resident_size` (older)  |
| **Memory Unit**       | KB (consistent)                         | Bytes (iOS), KB (Android)   |
| **CPU Value Range**   | 0-100+ (allows >100%)                   | 0-100 (filters >100%)       |
| **Android**           | ✅ Identical implementation             | ✅ Identical implementation |
| **Config Type**       | Milliseconds (number)                   | Duration object             |

---

### Refresh Rate & Frame Monitoring

#### How Data is Collected

##### **React Native SDK**

**iOS:**

- Uses `CADisplayLink` for frame callbacks
- Calculates FPS from frame timestamps: `fps = 1.0 / frameDuration`
- ProMotion support: Normalizes 120Hz to 60Hz baseline
- Real-time frame monitoring with polling for metrics

**Android:**

- Uses `Choreographer.FrameCallback` for frame timing
- Calculates FPS: `fps = 1,000,000,000 / frameDuration`
- Event-based slow frame detection with event grouping
- Throttled refresh rate emission (every 30s)

**Unique Features:**

- **Slow Frame Detection**: Event-based grouping of consecutive slow frames
  - Groups consecutive frames below target FPS as single "event"
  - Minimum duration: 50ms (~3 frames at 60fps) to be counted
  - Filters out noise and reports user-perceptible jank
- **Frozen Frame Detection**: Individual frames exceeding threshold
  - Default: 100ms
  - Tracks count and total duration

##### **Flutter SDK**

**iOS:**

- Uses `CADisplayLink` (same as React Native)
- ProMotion normalization (same algorithm)
- Polling-based collection
- ❌ No slow/frozen frame callbacks on iOS (refresh rate only)

**Android:**

- Uses `Choreographer` (same API as React Native)
- Event callback to Dart layer via method channel
- Dual collection: Polling + events
- ✅ Slow frame detection: counts frames where fps < 60, sends `onSlowFrames` → `app_frames_rate`
- ✅ Frozen frame detection: counts frames > 100ms, sends `onFrozenFrame` → `app_frozen_frame`

**Implementation difference vs React Native:**

- **Slow frames**: Flutter uses raw frame count per interval; React Native uses event-based grouping (consecutive slow frames grouped into events, min 50ms)
- **Frozen frames**: Flutter sends count only; React Native sends count + `frozen_duration` (ms)

---

#### Metric Format Sent to Faro

##### **React Native SDK**

**Refresh Rate:**

```json
{
  "type": "app_refresh_rate",
  "values": {
    "refresh_rate": 60.0
  }
}
```

**Slow Frames (Event Count):**

```json
{
  "type": "app_frames_rate",
  "values": {
    "slow_frames": 3
  }
}
```

- **Important**: `slow_frames` is the count of slow frame **events**, not individual frames
- Each event represents a period of consecutive slow frames lasting ≥50ms

**Frozen Frames:**

```json
{
  "type": "app_frozen_frame",
  "values": {
    "frozen_frames": 2,
    "frozen_duration": 450.5
  }
}
```

- `frozen_frames`: Count of frames exceeding threshold
- `frozen_duration`: Total duration in milliseconds

##### **Flutter SDK**

**Refresh Rate:**

```json
{
  "type": "app_refresh_rate",
  "values": {
    "refresh_rate": 60.0
  }
}
```

**Slow Frames (Android):**

```json
{
  "type": "app_frames_rate",
  "values": {
    "slow_frames": 3
  }
}
```

- Raw count per interval (no event grouping)

**Frozen Frames (Android):**

```json
{
  "type": "app_frozen_frame",
  "values": {
    "frozen_frames": 2
  }
}
```

- Count only (no duration)

---

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  url: 'https://your-collector.com',
  app: { name: 'my-app', version: '1.0.0' },
  // Enable frame monitoring (flag-based)
  refreshRateVitals: true, // default: false

  // Advanced frame monitoring options
  frameMonitoringOptions: {
    targetFps: 60, // default: 60
    frozenFrameThresholdMs: 100, // default: 100ms
    refreshRatePollingInterval: 30000, // default: 30000 (30s)
    normalizedRefreshRate: 60, // default: 60 (ProMotion)
  },
});
```

**Configuration Options:**

- `refreshRateVitals`: Enable/disable frame monitoring (disabled by default due to overhead)
- `targetFps`: Threshold for slow frame detection
- `frozenFrameThresholdMs`: Threshold for frozen frames
- `refreshRatePollingInterval`: How often to collect and send metrics
- `normalizedRefreshRate`: Baseline for high-refresh displays

##### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    refreshRateVitals: true,  // default: false
    fetchVitalsInterval: Duration(seconds: 30),
  ),
);
```

**Configuration Options:**

- `refreshRateVitals`: Enable/disable refresh rate monitoring
- ⚠️ No configurable thresholds or advanced options

---

#### Key Differences

| Feature                    | React Native                            | Flutter                       |
| -------------------------- | --------------------------------------- | ----------------------------- |
| **Default Enabled**        | ❌ false                                | ❌ false                      |
| **Refresh Rate**           | ✅ iOS & Android                        | ✅ iOS & Android              |
| **Slow Frame Detection**   | ✅ Event-based grouping (iOS & Android) | ✅ Count-based (Android only) |
| **Frozen Frame Detection** | ✅ Count + duration (iOS & Android)     | ✅ Count only (Android only)  |
| **ProMotion Support**      | ✅ Normalizes to 60 FPS                 | ✅ Normalizes to 60 FPS       |
| **Configurable Options**   | ✅ Extensive                            | ❌ Minimal                    |
| **Collection Method**      | Polling + Events                        | Polling + Events              |
| **Polling Interval**       | Configurable (30s default)              | Fixed via fetchVitalsInterval |

---

### Startup Time Metrics

#### How Data is Collected

##### **React Native SDK**

**iOS:**

- Uses `sysctl()` with `KERN_PROC_PID` to query process start time
- Formula: `currentTime - processStartTime`
- No manual initialization required (OS tracks automatically)
- Measures from process start to first measurement call

**Android:**

- Uses `Process.getStartElapsedRealtime()` (API 24+)
- Formula: `SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()`
- Returns duration from process start to now
- Returns 0 if Android version < API 24 (Nougat)

**Collection:**

- Cold start: When `StartupInstrumentation` initializes (native `getAppStartDuration`)
- Warm start: When app resumes from background (AppState `background`/`inactive` → `active`)
- Automatic—no demo app or manual setup required

##### **Flutter SDK**

**iOS:**

- Uses `sysctl()` with `KERN_PROC_PID` (identical to React Native)
- Formula: `currentTime - processStartTime`
- Called via method channel from Dart

**Android:**

- Uses `Process.getStartElapsedRealtime()` (identical to React Native)
- Same API requirements (API 24+)

---

#### Metric Format Sent to Faro

##### **React Native SDK**

**Cold start** (app launch):

```json
{
  "type": "app_startup",
  "values": {
    "appStartDuration": 3840,
    "coldStart": 1
  }
}
```

**Warm start** (resume from background):

```json
{
  "type": "app_startup",
  "values": {
    "appStartDuration": 85,
    "coldStart": 0
  }
}
```

##### **Flutter SDK**

**Cold start:**

```json
{
  "type": "app_startup",
  "values": {
    "appStartDuration": 1234,
    "coldStart": 1
  }
}
```

**Warm start:**

```json
{
  "type": "app_startup",
  "values": {
    "appStartDuration": 85,
    "coldStart": 0
  }
}
```

---

#### Configuration

##### **React Native SDK**

```typescript
// Startup instrumentation is included by default (flag-based config)
initializeFaro({
  url: 'https://your-collector.com',
  app: { name: 'my-app', version: '1.0.0' },
  // StartupInstrumentation is automatically included by makeRNConfig
});
```

- ✅ Included by default when using `initializeFaro` (makeRNConfig builds instrumentations)
- Cold and warm start tracked automatically—no configuration needed

##### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    // Startup tracking is built-in, no configuration needed
  ),
);
```

- ✅ Built into native integration
- Collected automatically via method channel

---

#### Key Differences

| Aspect            | React Native                        | Flutter                             |
| ----------------- | ----------------------------------- | ----------------------------------- |
| **Cold Start**    | ✅ Native `getAppStartDuration`     | ✅ Native `getAppStart`             |
| **Warm Start**    | ✅ AppState (background → active)   | ✅ WidgetsBindingObserver           |
| **Format**        | `appStartDuration`, `coldStart` 0/1 | `appStartDuration`, `coldStart` 0/1 |
| **iOS API**       | `sysctl()`                          | `sysctl()`                          |
| **Android API**   | `getStartElapsedRealtime()`         | `getStartElapsedRealtime()`         |
| **Configuration** | Included by default                 | Built-in                            |

---

#### Testing Cold vs Warm Start (Android Emulator)

**Cold start:**

1. Force stop the app or swipe it away from recent apps
2. Launch the app
3. Expect: `app_startup` with `coldStart: 1`, `appStartDuration` = process start to Faro init

**Warm start:**

1. With app running, press Home or switch to another app
2. Wait a few seconds
3. Bring the app back to foreground
4. Expect: `app_startup` with `coldStart: 0`, `appStartDuration` = resume to first frame

**Verify:** `adb logcat | grep -i faro` or enable `enableTransports: { console: true }` for Metro logs.

---

### HTTP Instrumentation

#### Event Name Differences

| SDK              | Event Name           | When Emitted                                                                                 |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| **Flutter**      | `http_request`       | One event per successful request only; failed requests do not emit this event                |
| **React Native** | `faro.tracing.fetch` | One event per request (success or failure). Same format as Web SDK for Grafana HTTP insights |

---

#### How Data is Collected

##### **React Native SDK**

The SDK automatically tracks HTTP requests made with both **fetch** and **XMLHttpRequest** (including libraries that use XHR, such as axios). No code changes are required—network calls are intercepted and reported.

**What is captured:**

- URL, method, status code, duration, request and response sizes
- Both successful and failed requests (network errors get `status_code: 0` and an error message)
- Data is sent as `faro.tracing.fetch` events for Grafana HTTP insights

**What is excluded:**

- Collector and transport URLs are not traced
- URLs matching `ignoreUrls` are skipped

##### **Flutter SDK**

The SDK automatically tracks HTTP requests made with the `http` package and **dio** (both use Dart's built-in `HttpClient`). No manual instrumentation is needed.

**What is captured:**

- URL, method, status code, request and response sizes, duration
- **Success only:** Failed requests (connection errors, timeouts) do not emit `http_request` events

**Scope:** Covers all code using `http` or `dio`. The `fetch` API is not available in Flutter.

#### Tracing for HTTP Requests

| SDK              | Tracing Behavior                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **React Native** | Optional. With `enableTracing: false` (default), HTTP events are sent without distributed trace context. With `enableTracing: true` and `@grafana/faro-react-native-tracing` installed, HTTP requests get full distributed tracing (trace IDs, span IDs, `traceparent` header propagated to backends). |
| **Flutter**      | Built-in. HTTP events always include `trace_id` and `span_id`, and the SDK injects the `traceparent` header into outgoing requests so backend traces can be correlated.                                                                                                                                |

---

#### Metric Format Sent to Faro

##### **React Native SDK** (`faro.tracing.fetch`)

**Successful request:**

```json
{
  "name": "faro.tracing.fetch",
  "attributes": {
    "http.url": "https://api.example.com/users/1",
    "http.method": "GET",
    "http.scheme": "https",
    "http.host": "api.example.com",
    "http.status_code": "200",
    "duration_ns": "125000000",
    "http.response_size": "1024"
  }
}
```

**Failed request (network error):**

```json
{
  "name": "faro.tracing.fetch",
  "attributes": {
    "http.url": "https://api.example.com/users/1",
    "http.method": "GET",
    "http.scheme": "https",
    "http.host": "api.example.com",
    "http.status_code": "0",
    "http.error": "Network request failed",
    "duration_ns": "5000000000"
  }
}
```

##### **Flutter SDK** (`http_request` — success only)

```json
{
  "name": "http_request",
  "attributes": {
    "url": "https://api.example.com/users/1",
    "method": "GET",
    "status_code": "200",
    "response_size": "1024",
    "request_size": "0",
    "content_type": "application/json",
    "duration": "125",
    "eventStart": "1678901234000",
    "eventEnd": "1678901234125",
    "trace_id": "abc123",
    "span_id": "def456"
  }
}
```

---

#### Key Differences

| Aspect                    | React Native                             | Flutter                                    |
| ------------------------- | ---------------------------------------- | ------------------------------------------ |
| **Event name**            | `faro.tracing.fetch` (Web SDK format)    | `http_request`                             |
| **Success + failure**     | ✅ Both emit event                       | Success only; failures omit `http_request` |
| **What is tracked**       | fetch + XMLHttpRequest (including axios) | `http` package + dio                       |
| **Scope**                 | All JS network calls using fetch or XHR  | All code using `http` or `dio`             |
| **Distributed tracing**   | Optional (`enableTracing`)               | Always on                                  |
| **Grafana HTTP insights** | ✅ Compatible                            | Via span-to-event mapping                  |

---

### Crash Reporting

#### How Data is Collected

##### **React Native SDK**

**iOS:**

- Uses **PLCrashReporter** (optional dependency)
- Captures native iOS crashes from previous sessions
- Requires explicit enabling: `enableCrashReporting: true`
- Processes crash reports on next app launch

**Crash Report Format**:

```json
{
  "reason": "SIGSEGV",
  "timestamp": 1678901234567,
  "description": "Attempted to dereference null pointer",
  "trace": "Stack trace string...",
  "signal": {
    "name": "SIGSEGV",
    "code": "SEGV_MAPERR",
    "address": "0x0"
  }
}
```

**Android:**

- Uses **ApplicationExitInfo** API (Android 11+, API 30+)
- Retrieves crash and ANR information from previous sessions
- Returns list of exit reasons including crashes

**Crash Report Format** :

```json
{
  "reason": "CRASH_NATIVE",
  "timestamp": 1678901234567,
  "description": "Native crash",
  "trace": "Stack trace..."
}
```

##### **Flutter SDK**

**iOS:**

- Uses **PLCrashReporter** (same as React Native)
- Sends crash via native `CrashReportingIntegration` with `meta.session` from current init (the session after restart, not the one during the crash)

**Android:**

- Uses **ApplicationExitInfo** (same as React Native)
- `ExitInfoHelper` builds crash JSON (reason, timestamp, trace, etc.) without the pre-crash Faro session id

---

#### Metric Format Sent to Faro

##### **React Native SDK**

```json
{
  "exceptions": [
    {
      "type": "crash",
      "value": "SIGSEGV: Attempted to dereference null pointer, status: 0",
      "timestamp": "2024-01-15T10:25:33.000Z",
      "context": {
        "trace": "Stack trace string...",
        "timestamp": "1678901234567",
        "description": "Attempted to dereference null pointer",
        "crashedSessionId": "abc-123-def-456",
        "processName": "com.example.app",
        "pid": "12345",
        "importance": "100"
      },
      "stacktrace": {
        "frames": [
          { "filename": "SomeNativeModule.m", "function": "processData", "lineno": 145 }
        ]
      }
    }
  ],
  "meta": { "session": {...}, "app": {...} }
}
```

**Sent via:** `faro.api.pushError()`

- **`type`**: `"crash"` (from `pushError` options)
- **`value`**: Error message string (e.g. `"{reason}: {description}, status: {status}"`)
- **`context`**: Crash report fields (trace, timestamp, description, processName, pid, importance); `signal` on iOS
- **`stacktrace`**: Parsed frames if available from native report

**Sent via:** `faro.api.pushError(error, { type: 'crash', context })`

##### **Flutter SDK**

- Uses `pushError()` with crash context (description, stacktrace, timestamp, etc.)

---

#### Configuration

##### **React Native SDK**

```typescript
import { initializeFaro } from '@grafana/faro-react-native';

initializeFaro({
  url: 'https://your-collector.com',
  app: { name: 'my-app', version: '1.0.0' },
  // Enable crash reporting (flag-based)
  enableCrashReporting: true, // default: false
});
```

**iOS Additional Setup:**

```bash
# Add PLCrashReporter dependency
cd ios
pod install
```

**Android:**

- No additional setup required
- Works on Android 11+ (API 30+) automatically

##### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    enableCrashReporting: true,  // default: false
  ),
);
```

**iOS Additional Setup:**

- PLCrashReporter included in podspec
- Automatic via pod install

---

#### Key Differences

| Aspect                     | React Native                                                | Flutter                                               |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| **Default Enabled**        | ❌ false                                                    | ❌ false                                              |
| **iOS Implementation**     | PLCrashReporter                                             | PLCrashReporter (same)                                |
| **Android Implementation** | ApplicationExitInfo                                         | ApplicationExitInfo (same)                            |
| **iOS Requirement**        | PLCrashReporter pod                                         | PLCrashReporter pod                                   |
| **Android Requirement**    | API 30+ (Android 11)                                        | API 30+ (Android 11)                                  |
| **Pre-crash session id**   | ❌ Not in crash payload (`meta.session` is after restart) | ❌ Not in crash payload                               |
| **Error Type**             | `crash` (native)                                            | `crash` (native), `flutter_error` (ANR, FlutterError) |

The **Error Type** in both SDKs is `crash` for native errors but in React native the value change depending of the type of crash:

- `ANR: Application Not Responding`,
- `CRASH: Application crash (Java/Kotlin)`,
- `SIGTRAP: Trace/BPT trap` (iOS)

> **🔴 REVIEW NEEDED:** Regarding `ANR` in Flutter SDK is not sent as a `crash` type but as `flutter_error`. Should we update it?

---

#### Crash reports and session

Native crashes are delivered on the next launch. The exception is sent with `meta.session` for that launch (the reporting session), not the session that was active when the process died. Neither React Native nor Flutter adds a separate field for the pre-crash session id on the crash payload.

---

### ANR Detection

#### How Data is Collected

##### **React Native SDK**

**Android Only:**

- Monitors main thread responsiveness
- Spawns watchdog thread that pings main thread
- If main thread doesn't respond within timeout → ANR detected
- Captures stack trace at time of detection
- Default timeout: 5000ms (5 seconds)

**Implementation:**

```kotlin
// ANRTracker watches for main thread blocking
class ANRTracker {
  - Posts runnable to main thread handler
  - If not executed within timeout → ANR
  - Captures thread dump for analysis
}
```

**iOS:**

- ❌ Not applicable (iOS has different watchdog mechanism)
- React Native doesn't implement iOS ANR detection

##### **Flutter SDK**

**Android:**

- Similar watchdog pattern
- Monitors main thread responsiveness
- Configurable timeout

**iOS:**

- ❌ Not implemented

---

#### Metric Format Sent to Faro

##### **React Native SDK**

React Native has **two ANR sources**, each with a different payload:

**1. CrashReporting (Android ApplicationExitInfo)** — when the system kills the app due to ANR:

Sent via `faro.api.pushError()` with **`type: 'crash'`**:

```json
{
  "type": "crash",
  "value": "ANR: Application Not Responding, status: 0",
  "context": {
    "trace": "Main thread stack trace...",
    "timestamp": "1678901234567",
    "description": "..."
  }
}
```

**2. ANRInstrumentation (in-session detection)** — when main thread blocks but app recovers:

- **Error** via `faro.api.pushError()` (no explicit `type`, uses default):
  ```json
  {
    "value": "ANR (Application Not Responding)",
    "context": {
      "stacktrace": "Main thread stack trace...",
      "duration": "5234",
      "timestamp": "1678901234567"
    }
  }
  ```
- **Measurement** via `faro.api.pushMeasurement()`:
  ```json
  {
    "type": "anr",
    "values": { "anr_count": 1 }
  }
  ```

##### **Flutter SDK**

Similar ANR error format with platform-specific details.

---

#### Configuration

##### **React Native SDK**

```typescript
import { initializeFaro } from '@grafana/faro-react-native';

initializeFaro({
  url: 'https://your-collector.com',
  app: { name: 'my-app', version: '1.0.0' },
  // Enable ANR detection (Android only, flag-based)
  anrTracking: true, // default: false
  anrOptions: {
    timeout: 5000, // default: 5000ms
  },
});
```

**Options:**

- `anrTracking`: Enable/disable ANR detection
- `anrOptions.timeout`: How long to wait before considering thread blocked

##### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    anrTracking: true,  // default: false, Android only
    // Timeout is not configurable; fixed at 5000ms in native ANRTracker
  ),
);
```

---

#### Key Differences

| Aspect                   | React Native    | Flutter              |
| ------------------------ | --------------- | -------------------- |
| **Android Support**      | ✅ Yes          | ✅ Yes               |
| **iOS Support**          | ❌ No           | ❌ No                |
| **Default Enabled**      | ❌ false        | ❌ false             |
| **Configurable Timeout** | ✅ Yes          | ❌ No (fixed 5000ms) |
| **Stack Trace Capture**  | ✅ Yes          | ✅ Yes               |
| **Detection Method**     | Watchdog thread | Similar watchdog     |

---

### App State

#### How Data is Collected

##### **React Native SDK**

- Uses React Native's **AppState** API
- Subscribes to `change` events
- `fromState` / `toState` use native **AppState** values (`active`, `background`, `inactive`, `unknown`, `extension`)
- Always enabled (no config flag)

##### **Flutter SDK**

- Uses `WidgetsBindingObserver.didChangeAppLifecycleState` with `AppLifecycleState`
- Tracks: resumed, paused, inactive, detached, hidden

---

#### Metric Format Sent to Faro

##### **React Native SDK**

```json
{
  "events": [
    {
      "name": "app_lifecycle_changed",
      "attributes": {
        "fromState": "active",
        "toState": "background",
        "duration": "45000",
        "timestamp": "1678901234567"
      }
    }
  ]
}
```

**Sent via:** `faro.api.pushEvent('app_lifecycle_changed', { fromState, toState, duration, timestamp })`

##### **Flutter SDK**

```json
{
  "events": [
    {
      "name": "app_lifecycle_changed",
      "attributes": {
        "fromState": "resumed",
        "toState": "paused"
      }
    }
  ]
}
```

---

#### Key Differences

| Aspect               | React Native                                                   | Flutter                                                         |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| **API**              | AppState.addEventListener                                      | WidgetsBindingObserver (didChangeAppLifecycleState)             |
| **Always Enabled**   | ✅ Yes                                                         | ✅ Yes                                                          |
| **Event Name**       | `app_lifecycle_changed`                                        | `app_lifecycle_changed`                                         |
| **Event Attributes** | fromState, toState, duration, timestamp                        | fromState, toState ⚠️ No duration/timestamp                     |
| **State Names**      | active, background, inactive, unknown, extension (AppState)   | resumed, paused, inactive, detached, hidden (AppLifecycleState) |

---

### Console Capture

#### How Data is Collected

##### **React Native SDK**

- Patches `console.log`, `console.warn`, `console.error`, `console.debug`, `console.trace`
- **console.error**: By default sent as exception via `pushError()`; optionally as log via `consoleErrorAsLog`
- Other levels: Sent as logs via `pushLog()`
- Configurable: disable specific levels (default: debug, trace, log disabled to reduce noise)

##### **Flutter SDK**

- ❌ No direct equivalent (Dart `print`/`debugPrint` not patched)
- Logging typically via custom integrations

---

#### Metric Format Sent to Faro

##### **React Native SDK**

**Log (console.log, console.warn, etc.):**

```json
{
  "logs": [
    {
      "level": "info",
      "message": ["User clicked button"],
      "timestamp": "2024-01-15T10:25:33.000Z"
    }
  ]
}
```

**Error (console.error when consoleErrorAsLog: false):**

```json
{
  "exceptions": [
    {
      "type": "Error",
      "value": "console.error: Something went wrong",
      "context": { "mechanism": "console" },
      "stacktrace": { "frames": [...] }
    }
  ]
}
```

---

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  enableConsoleCapture: true, // default: true
  consoleCaptureOptions: {
    disabledLevels: [LogLevel.DEBUG, LogLevel.TRACE, LogLevel.LOG],
    consoleErrorAsLog: false, // treat console.error as exception (default) or log
    serializeErrors: true,
  },
});
```

---

#### Key Differences

| Aspect              | React Native          | Flutter          |
| ------------------- | --------------------- | ---------------- |
| **Console Capture** | ✅ Patches console.\* | ❌ No equivalent |
| **Default Enabled** | ✅ true               | N/A              |

---

### Error Reporting

#### How Data is Collected

##### **React Native SDK**

- Patches **ErrorUtils** (React Native global) for unhandled JS errors
- Listens to **unhandledrejection** for promise rejections
- Parses stack traces (dev, release, Metro formats)
- Adds platform context (OS, Hermes)
- **Deduplication**: Same errors (identical message and stack) within a time window are not reported again. Default window: 5 seconds. Configurable via `enableDeduplication`, `deduplicationWindow`, and `maxDeduplicationEntries`.
- **Filtering**: `ignoreErrors` regex patterns
- **Error type and mechanism**: Aligned with Web SDK—uses the error's `name` as `type` (typically `Error`) and adds `mechanism` in context to indicate capture source (uncaught, unhandledrejection, console, crash, anr)

##### **Flutter SDK**

- Uses **FlutterError.onError** and **PlatformDispatcher.onError**
- Tracks unhandled Dart exceptions and zone errors
- Promise/future rejections via zone

---

#### Metric Format Sent to Faro

##### **React Native SDK**

Each exception includes two classification dimensions:

- **`type`**: Reflects the error's `name` property (matches Web SDK)
  - Typically `Error` for `throw new Error(...)` or `console.error(...)`
  - `UnhandledRejection` for promise rejections with non-Error values (primitives, plain objects)
  - `crash` for native crashes; `ANR` for Application Not Responding
- **`context.mechanism`**: Where the error was captured
  - `uncaught` — from ErrorUtils (unhandled synchronous JS)
  - `unhandledrejection` — from unhandled promise rejection
  - `console` — from patched console.error
  - `crash` — from native crash reporting
  - `anr` — from ANR detection

**Error reference table** (type, value, mechanism, and key context props):

| Source                          | `type`               | `value` pattern                                                          | `context.mechanism`  | Key context props                                    |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------- |
| Uncaught sync error             | `Error`              | Raw message (e.g. `"This is a synchronous error for testing"`)           | `uncaught`           | `isFatal`, `isHermes`, `platform`, `platformVersion` |
| Uncaught sync (via console)     | `Error`              | Prefixed: `"console.error: {message}"`                                   | `console`            | —                                                    |
| Unhandled promise (Error)       | `Error`              | Raw message or `"Unhandled Promise Rejection: …"`                        | `unhandledrejection` | `platform`, `isHermes`, `platformVersion`            |
| Unhandled promise (via console) | `Error`              | Prefixed: `"console.error: Uncaught (in promise, id: N): \"{message}\""` | `console`            | —                                                    |
| Primitive rejection             | `UnhandledRejection` | `"Unhandled Promise Rejection: …"`                                       | `unhandledrejection` | —                                                    |
| console.error (explicit)        | `Error`              | Prefixed: `"console.error: {message}"`                                   | `console`            | —                                                    |
| Native crash                    | `crash`              | Crash description string                                                 | `crash`              | `description`, `trace`, `timestamp`, etc.            |
| ANR                             | `ANR`                | ANR description                                                          | `anr`                | —                                                    |

**Note:** The same synchronous error can appear twice—once from ErrorUtils (`mechanism=uncaught`) and once from the patched console (`mechanism=console`) because React Native logs uncaught errors to `console.error`. The console variant has the `"console.error: "` prefix in `value`. Unhandled promise rejections may also be captured via console when the runtime logs them before the `unhandledrejection` event.

**Uncaught JavaScript error:**

```json
{
  "exceptions": [
    {
      "type": "Error",
      "value": "This is a synchronous error for testing",
      "timestamp": "2024-01-15T10:25:33.000Z",
      "stacktrace": "...",
      "context": {
        "mechanism": "uncaught",
        "isFatal": "true",
        "isHermes": "true",
        "platform": "android",
        "platformVersion": "36"
      }
    }
  ]
}
```

**Unhandled promise rejection (Error, via unhandledrejection):**

```json
{
  "exceptions": [
    {
      "type": "Error",
      "value": "This is an async error for testing",
      "context": {
        "mechanism": "unhandledrejection",
        "platform": "android",
        "isHermes": "true",
        "platformVersion": "36"
      }
    }
  ]
}
```

**Unhandled promise rejection (via console—common in React Native / Metro):**

```json
{
  "exceptions": [
    {
      "type": "Error",
      "value": "console.error: Uncaught (in promise, id: 1): \"Error: This is an async error for testing\"",
      "context": { "mechanism": "console" }
    }
  ]
}
```

**Unhandled promise rejection (primitive/non-Error):**

```json
{
  "exceptions": [
    {
      "type": "UnhandledRejection",
      "value": "Unhandled Promise Rejection: ...",
      "context": { "mechanism": "unhandledrejection" }
    }
  ]
}
```

**Console.error (when sent as exception):**

```json
{
  "exceptions": [
    {
      "type": "Error",
      "value": "console.error: Failed to load data",
      "context": { "mechanism": "console" }
    }
  ]
}
```

---

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  enableErrorReporting: true, // default: true
  // When using custom instrumentations:
  instrumentations: [
    new ErrorsInstrumentation({
      ignoreErrors: [/network timeout/i, /cancelled/i],
      enableDeduplication: true,
      deduplicationWindow: 5000,
      maxDeduplicationEntries: 50,
    }),
  ],
});
```

---

#### Key Differences

| Aspect            | React Native                                                                             | Flutter                           |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| **Source**        | ErrorUtils + unhandledrejection                                                          | FlutterError + PlatformDispatcher |
| **Error Type**    | Reflects `error.name` (typically `Error`); `UnhandledRejection` for primitive rejections | Often `flutter_error` bucket      |
| **Mechanism**     | `context.mechanism` (uncaught, unhandledrejection, console, crash, anr)                  | N/A                               |
| **Deduplication** | ✅ Fingerprint (message+stack), 5s window, configurable                                  | ❌ None                           |

---

### Session Management

#### How Data is Collected

##### **React Native SDK**

- **SessionInstrumentation** manages session lifecycle
- **Volatile mode** (default): In-memory only; new session each app launch
- **Persistent mode** (optional): AsyncStorage; survives app restarts; 4h max, 15min inactivity timeout
- Events: `session_start`, `session_extend`, `session_resume`
- Auto-collects session attributes: device_id, device_os, device_model, RN version, etc.

##### **Flutter SDK**

- No session persistence — each app launch creates a new session
- No session expiration — session lasts until app process ends
- Single event: `session_start` on init
- Session attributes from device info

### Volatile vs Persistent (React Native Only)

React Native offers two session modes. Flutter does not support either; it always creates a new session on each app launch.

| Mode                   | Storage      | Survives app restart | When session ends            |
| ---------------------- | ------------ | -------------------- | ---------------------------- |
| **Volatile** (default) | In-memory    | No                   | App killed                   |
| **Persistent**         | AsyncStorage | Yes                  | 15 min inactivity or 4 h max |

**Advantages of Persistent mode:**

- **Unique session count** — count of `session_start` reflects distinct sessions, not every launch
- **Session duration** — measure time from first start to last activity across app switches
- **Returns per session** — `(session_start + session_resume) / session_start` shows engagement depth
- **Market alignment** — common in RUM tools (e.g. Datadog: 15 min inactivity, 4 h max)

**Flutter behavior:** A user who backgrounds and returns twice creates 3 separate sessions (each launch = new session). React Native with persistent mode treats this as one session with multiple returns.

### Session Extend (React Native & Web SDK)

`session_extend` is emitted when a **new session** is created because the previous one expired (inactivity or 4 h max), and the new session links to the old. The old session is not extended; a fresh session ID is created. This lets backends treat the new session as continuing the same logical visit. Flutter does not emit `session_extend`.

**Where the previous session ID appears:**

- **`session_attr_previousSession`** — Stored as a session attribute, so it is attached to **all** telemetry (logs, exceptions, events) in the new session. This is the primary way to see the previous session on regular telemetry.
- **`event_data_previousSession`** — In the `session_extend` event payload only.

**When it happens:** `session_extend` occurs when `updateSession` runs (e.g. on app foreground or before sending telemetry) while the app is **still in memory** and the session has expired. It does **not** occur when the app was killed and reopened after 4+ h — in that case the stored session is cleared before creating the new one, so no `previousSession` link exists and `session_start` is emitted instead.

### Session Resume (React Native & Web SDK)

`session_resume` is emitted when the app **restarts** (cold start) and finds a **valid existing session** in storage. The same session ID is reused instead of creating a new one. Flutter does not emit `session_resume` (each launch is a new session).

**When it happens:** `session_resume` occurs during Faro initialization when persistent mode is enabled and a stored session exists that is still valid: within 4 h of `started`, and within 15 min of `lastActivity`. If the stored session has expired (inactivity or max lifetime), it is cleared and `session_start` is emitted instead. In volatile mode (non-persistent), every app launch emits `session_start` only.

### Using session_resume for Analytics

With persistent mode, `session_resume` supports questions like:

- **How many sessions end after a single foreground period?** — compare sessions with 1 event vs more
- **How often do users actually return within the same session?** — count `session_resume` per `session_start`

---

#### Metric Format Sent to Faro

##### **React Native SDK**

```json
{
  "events": [
    {
      "name": "session_start",
      "attributes": {}
    }
  ],
  "meta": {
    "session": {
      "id": "abc-123-session-id",
      "attributes": {
        "device_id": "...",
        "device_os": "iOS 17.2",
        "device_model_name": "iPhone 15"
      }
    }
  }
}
```

---

#### Configuration

##### **React Native SDK**

Sessions are always enabled. Options (via faro-core config):

| Option                      | Default           | Description                                               |
| --------------------------- | ----------------- | --------------------------------------------------------- |
| `persistent`                | `false`           | Persist sessions across app restarts (AsyncStorage)       |
| `maxSessionPersistenceTime` | `900000` (15 min) | Max age of stored session before clear on cold start (ms) |
| `inactivityTimeout`         | `900000` (15 min) | Inactivity before session invalid (ms)                    |
| `sessionExpirationTime`     | `14400000` (4 h)  | Max session lifetime from start (ms)                      |

---

#### Key Differences

| Aspect                 | React Native                                        | Flutter                |
| ---------------------- | --------------------------------------------------- | ---------------------- |
| **Storage**            | Volatile: in-memory; Persistent: AsyncStorage       | No session persistence |
| **Session expiration** | 4 h max, 15 min inactivity                          | None                   |
| **Events**             | `session_start`, `session_resume`, `session_extend` | `session_start` only   |
| **Always enabled**     | Yes                                                 | Yes                    |

---

### Session Sampling

Session sampling lets you send telemetry only for a fraction of sessions to reduce volume and cost while keeping representative data.

#### How Data is Collected

##### **React Native SDK**

- Sampling decision is made once per session when the session is created
- Non-sampled sessions: telemetry is not sent to transports (logs, exceptions, events, traces are dropped)
- Sampled sessions: telemetry is sent as usual
- Supports `samplingRate` (0–1) or custom `sampler` function that receives metas

##### **Flutter SDK**

- Same pattern: decision once per session at creation
- Supports `SamplingRate` (0.0–1.0) for fixed rate
- Supports `SamplingFunction` for dynamic sampling (e.g. by app environment, user attributes)

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  sessionTracking: {
    samplingRate: 0.1, // 10% of sessions
    // Or custom function:
    sampler: ({ metas }) => (metas.app?.environment === 'production' ? 0.1 : 1.0),
  },
});
```

##### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    sampling: SamplingRate(0.1), // 10% of sessions
    // Or dynamic:
    sampling: SamplingFunction((context) {
      if (context.meta.app?.environment == 'production') return 0.1;
      return 1.0;
    }),
  ),
);
```

#### Key Differences

| Aspect         | React Native                         | Flutter                               |
| -------------- | ------------------------------------ | ------------------------------------- |
| **Default**    | 100% (all sessions sampled)          | 100%                                  |
| **Fixed rate** | `sessionTracking.samplingRate` (0–1) | `SamplingRate(rate)`                  |
| **Dynamic**    | `sessionTracking.sampler` function   | `SamplingFunction((context) => rate)` |
| **Scope**      | Per session (all or nothing)         | Per session                           |

> 🔴 **Note:** Consider whether the Flutter SDK should align naming with Web SDK and React Native (`sampler`, `samplingRate`) instead of `SamplingRate` / `SamplingFunction` for consistency across SDKs.

---

### User Actions

#### How Data is Collected

##### **React Native SDK**

- **UserActionInstrumentation** subscribes to user action message bus
- **withFaroUserAction** HOC: Wraps TouchableOpacity, etc.; auto-tracks press/tap
- **trackUserAction()**: Manual API for custom actions
- **UserActionController**: Duration tracking, HTTP correlation, halt state for pending requests

##### **Flutter SDK**

- **FaroUserInteractionWidget** wraps app
- **pushEvent('user_interaction')**, **Faro().startSpan('user_action', ...)**
- HTTP correlation via trace context

---

#### Metric Format Sent to Faro

##### **React Native SDK**

```json
{
  "events": [
    {
      "name": "user_action",
      "attributes": {
        "name": "button_pressed",
        "duration": "250",
        "context": "{}"
      }
    }
  ]
}
```

HTTP requests triggered during a user action are correlated via `httpRequestMonitor` (tracing) or HttpInstrumentation.

### Error and HTTP Correlation with User Actions (React Native)

The React Native SDK correlates both **HTTP errors** and **JavaScript errors** with user actions so they appear in Grafana Frontend Observability's user action table (HTTP Errors and Errors columns).

**HTTP errors (4xx, 5xx, network failures):**

- HTTP requests are tracked as `faro.tracing.fetch` events with `http.status_code` (400–599 or 0 for network errors)
- When a request occurs during an active user action (Started or Halted), the event includes `action.name` and `action.parentId`
- Grafana FEO links these events to the parent user action via `action_parent_id`, so the HTTP Errors column shows the count per action
- **When tracing is enabled** (`enableTracing: true`): The OTEL FetchInstrumentation and XMLHttpRequestInstrumentation create spans. A request hook adds `faro.action.user.name` and `faro.action.user.parentId` to each span when an active user action exists. The FaroTraceExporter converts these spans to `faro.tracing.fetch` / `faro.tracing.xml-http-request` events and injects `payload.action` from the span attributes. The span, trace, and event are all correlated to the same user action. The trace remains available for distributed tracing, and the event feeds the HTTP Errors column in the user action table.

**JavaScript errors:**

- Exceptions (uncaught, unhandled rejection, console.error) captured during a user action are buffered by the active UserAction
- When the action ends, buffered items (including exceptions) are flushed with `action.parentId` and `action.name` added to the payload
- This links the exception to the user action that triggered it, so the Errors column reflects which action caused the error
- FaroErrorBoundary also correlates React component errors with the active user action when the error occurs during a tracked interaction

**In Grafana:** The user action table shows HTTP Errors (from `faro.tracing.fetch` events with status 4xx/5xx/0 and action context) and Errors (from exceptions with action context) per action row.

---

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  enableUserActions: true, // default: true
  userActionsOptions: {
    dataAttributeName: 'data-faro-action',
    excludeItem: (element) => false,
  },
});
```

---

#### Key Differences

| Aspect               | React Native                                             | Flutter                                                  |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| **API**              | withFaroUserAction HOC + trackUserAction()               | FaroUserInteractionWidget + startSpan                    |
| **HTTP Correlation** | ✅ Automatic via trace and W3C Trace Context propagation | ✅ Automatic via trace and W3C Trace Context propagation |
| **Default Enabled**  | ✅ true                                                  | Opt-in (wrap app with widget)                            |

---

### View / Screen Tracking

#### How Data is Collected

##### **React Native SDK**

- **ViewInstrumentation** listens to meta changes
- Emits `view_changed` when screen name changes
- **useFaroNavigation** hook: Integrates with React Navigation; calls `ViewInstrumentation.setView(screenName)` on navigation
- Manual: `setView(name)` for non-React-Navigation apps

##### **Flutter SDK**

- **FaroNavigationObserver** for route tracking
- Similar view/screen change events

---

#### Metric Format Sent to Faro

##### **React Native SDK**

```json
{
  "events": [
    {
      "name": "view_changed",
      "attributes": {
        "fromView": "Home",
        "toView": "Profile"
      }
    }
  ],
  "meta": {
    "view": {
      "name": "Profile",
      "url": "Profile"
    }
  }
}
```

---

#### Configuration

##### **React Native SDK**

**React Navigation:**

```typescript
const navigationRef = useNavigationContainerRef();
useFaroNavigation(navigationRef);
<NavigationContainer ref={navigationRef}>...</NavigationContainer>
```

**Manual:**

```typescript
import { setView } from '@grafana/faro-react-native';
setView('ScreenName');
```

---

#### Key Differences

| Aspect             | React Native                         | Flutter                |
| ------------------ | ------------------------------------ | ---------------------- |
| **Integration**    | useFaroNavigation (React Navigation) | FaroNavigationObserver |
| **Manual API**     | setView(name)                        | setViewMeta(name:)     |
| **Always Enabled** | ✅ Yes                               | ✅ Yes                 |

---

### Offline Caching

Both SDKs can cache telemetry when the device is offline and replay it when connectivity returns. This avoids losing data during tunnels, airplane mode, or poor coverage.

#### How Data is Collected

##### **React Native SDK**

- Optional transport enabled via `enableTransports.offline: true`
- When offline: telemetry is written to AsyncStorage
- When online: connectivity is monitored; cached payloads are replayed through FetchTransport
- Default max cache duration: 3 days; configurable `maxCacheDurationMs`, `maxCacheSize`, `storageKeyPrefix`
- Replay skips expired entries (older than max duration)

##### **Flutter SDK**

- Manual setup: add `OfflineTransport` before `Faro.initialize()`
- When offline: telemetry is written to local file storage
- When online: connectivity listener triggers replay
- Configurable `maxCacheDuration`, `internetConnectionCheckerUrl`, custom connectivity service

#### Configuration

##### **React Native SDK**

```typescript
initializeFaro({
  enableTransports: { offline: true, fetch: true },
  // Optional: customize via manual transport when not using makeRNConfig
});

// Manual setup (advanced):
import { OfflineTransport } from '@grafana/faro-react-native';
new OfflineTransport({
  maxCacheDurationMs: 3 * 24 * 60 * 60 * 1000, // 3 days
  maxCacheSize: 1000,
  storageKeyPrefix: 'faro_offline_cache',
  connectivityCheckIntervalMs: 30000,
});
```

##### **Flutter SDK**

```dart
Faro().transports.add(OfflineTransport(
  maxCacheDuration: Duration(days: 3),
  internetConnectionCheckerUrl: 'https://example.com',
));
Faro.initialize(optionsConfiguration: faroConfig);
```

#### Key Differences

| Aspect           | React Native                                      | Flutter                                                            |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| **Enable**       | `enableTransports.offline: true` (default: false) | Manual: `Faro().transports.add(OfflineTransport(...))` before init |
| **Storage**      | AsyncStorage                                      | File storage (path_provider)                                       |
| **Connectivity** | Built-in (checks fetch reachability)              | `InternetConnectivityService` (configurable URL)                   |
| **Max duration** | 3 days (default), `maxCacheDurationMs`            | Optional `maxCacheDuration` (Duration)                             |
| **Max size**     | 1000 items (default), `maxCacheSize`              | No built-in limit                                                  |

---

## Reference Documents

The following sections are split into separate files to improve preview performance:

- **[Configuration Comparison](./configuration-comparison.md)** — Side-by-side React Native and Flutter config with full option comparison table.
- **[Threshold Proposals](./threshold-proposals.md)** — CPU, memory, refresh rate, startup, ANR, crash, and error thresholds with Grafana query examples.
- **[Real Log Examples](./real-log-examples.md)** — Logfmt samples for each telemetry type (startup, CPU/memory, frames, crash, ANR, HTTP, app state, console, errors, session, user actions, view tracking).
- **[Feature Parity Matrix](./feature-parity-matrix.md)** — Complete feature comparison, missing features & roadmap, best practices, and additional resources.
