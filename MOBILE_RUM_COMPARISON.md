# Mobile RUM: React Native & Flutter SDK Comparison

## Table of Contents

- [Overview](#overview)
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
- [User Actions](#user-actions)
- [View / Screen Tracking](#view--screen-tracking)
- [Configuration Comparison](#configuration-comparison)
- [Threshold Proposals](#threshold-proposals)
- [Real Log Examples](#real-log-examples)
- [Feature Parity Matrix](#feature-parity-matrix)

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

## CPU & Memory Metrics

### How Data is Collected

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Metric Format Sent to Faro

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Configuration

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Key Differences

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

## Refresh Rate & Frame Monitoring

### How Data is Collected

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Metric Format Sent to Faro

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Configuration

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Key Differences

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

## Startup Time Metrics

### How Data is Collected

#### **React Native SDK**

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

#### **Flutter SDK**

**iOS:**

- Uses `sysctl()` with `KERN_PROC_PID` (identical to React Native)
- Formula: `currentTime - processStartTime`
- Called via method channel from Dart

**Android:**

- Uses `Process.getStartElapsedRealtime()` (identical to React Native)
- Same API requirements (API 24+)

---

### Metric Format Sent to Faro

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Configuration

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Key Differences

| Aspect            | React Native                        | Flutter                             |
| ----------------- | ----------------------------------- | ----------------------------------- |
| **Cold Start**    | ✅ Native `getAppStartDuration`     | ✅ Native `getAppStart`             |
| **Warm Start**    | ✅ AppState (background → active)   | ✅ WidgetsBindingObserver           |
| **Format**        | `appStartDuration`, `coldStart` 0/1 | `appStartDuration`, `coldStart` 0/1 |
| **iOS API**       | `sysctl()`                          | `sysctl()`                          |
| **Android API**   | `getStartElapsedRealtime()`         | `getStartElapsedRealtime()`         |
| **Configuration** | Included by default                 | Built-in                            |

---

### Testing Cold vs Warm Start (Android Emulator)

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

## HTTP Instrumentation

### Event Name Differences

| SDK              | Event Name           | When Emitted                                                                                 |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| **Flutter**      | `http_request`       | One event per successful request only; failed requests do not emit this event                |
| **React Native** | `faro.tracing.fetch` | One event per request (success or failure). Same format as Web SDK for Grafana HTTP insights |

---

### How Data is Collected

#### **React Native SDK**

The SDK automatically tracks HTTP requests made with both **fetch** and **XMLHttpRequest** (including libraries that use XHR, such as axios). No code changes are required—network calls are intercepted and reported.

**What is captured:**

- URL, method, status code, duration, request and response sizes
- Both successful and failed requests (network errors get `status_code: 0` and an error message)
- Data is sent as `faro.tracing.fetch` events for Grafana HTTP insights

**What is excluded:**

- Collector and transport URLs are not traced
- URLs matching `ignoreUrls` are skipped

#### **Flutter SDK**

The SDK automatically tracks HTTP requests made with the `http` package and **dio** (both use Dart's built-in `HttpClient`). No manual instrumentation is needed.

**What is captured:**

- URL, method, status code, request and response sizes, duration
- **Success only:** Failed requests (connection errors, timeouts) do not emit `http_request` events

**Scope:** Covers all code using `http` or `dio`. The `fetch` API is not available in Flutter.

### Tracing for HTTP Requests

| SDK              | Tracing Behavior                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **React Native** | Optional. With `enableTracing: false` (default), HTTP events are sent without distributed trace context. With `enableTracing: true` and `@grafana/faro-react-native-tracing` installed, HTTP requests get full distributed tracing (trace IDs, span IDs, `traceparent` header propagated to backends). |
| **Flutter**      | Built-in. HTTP events always include `trace_id` and `span_id`, and the SDK injects the `traceparent` header into outgoing requests so backend traces can be correlated.                                                                                                                                |

---

### Metric Format Sent to Faro

#### **React Native SDK** (`faro.tracing.fetch`)

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

#### **Flutter SDK** (`http_request` — success only)

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

### Key Differences

| Aspect                    | React Native                             | Flutter                                    |
| ------------------------- | ---------------------------------------- | ------------------------------------------ |
| **Event name**            | `faro.tracing.fetch` (Web SDK format)    | `http_request`                             |
| **Success + failure**     | ✅ Both emit event                       | Success only; failures omit `http_request` |
| **What is tracked**       | fetch + XMLHttpRequest (including axios) | `http` package + dio                       |
| **Scope**                 | All JS network calls using fetch or XHR  | All code using `http` or `dio`             |
| **Distributed tracing**   | Optional (`enableTracing`)               | Always on                                  |
| **Grafana HTTP insights** | ✅ Compatible                            | Via span-to-event mapping                  |

---

## Crash Reporting

### How Data is Collected

#### **React Native SDK**

**iOS:**

- Uses **PLCrashReporter** (optional dependency)
- Captures native iOS crashes from previous sessions
- Requires explicit enabling: `enableCrashReporting: true`
- Processes crash reports on next app launch
- **Session correlation**: Persists session ID in UserDefaults; on next launch reads it and includes as `crashedSessionId` in the crash report

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
  },
  "crashedSessionId": "abc-123-def-456"
}
```

**Android:**

- Uses **ApplicationExitInfo** API (Android 11+, API 30+)
- Retrieves crash and ANR information from previous sessions
- Returns list of exit reasons including crashes
- **Session correlation**: Persists session ID in SharedPreferences; when processing crash/exit info, includes it as `crashedSessionId`

**Crash Report Format** :

```json
{
  "reason": "CRASH_NATIVE",
  "timestamp": 1678901234567,
  "description": "Native crash",
  "trace": "Stack trace...",
  "crashedSessionId": "abc-123-def-456"
}
```

#### **Flutter SDK**

**iOS:**

- Uses **PLCrashReporter** (same as React Native)
- Sends crash via native `CrashReportingIntegration` with `meta.session` from current init
- ⚠️ **No `crashedSessionId`**: meta.session is the new session on restart, not the crashed session

**Android:**

- Uses **ApplicationExitInfo** (same as React Native)
- `ExitInfoHelper` builds crash JSON (reason, timestamp, trace, etc.) but does not include session ID
- ⚠️ **No `crashedSessionId`**: crash context has no session correlation

---

### Metric Format Sent to Faro

#### **React Native SDK**

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
- **`context`**: Crash report fields (trace, timestamp, description, crashedSessionId, processName, pid, importance); `signal` on iOS
- **`stacktrace`**: Parsed frames if available from native report

**Sent via:** `faro.api.pushError(error, { type: 'crash', context })`

#### **Flutter SDK**

- Uses `pushError()` with crash context (description, stacktrace, timestamp, etc.)
- Does not include `crashedSessionId` in crash payload

---

### Configuration

#### **React Native SDK**

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

#### **Flutter SDK**

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

### Key Differences

| Aspect                     | React Native                                                | Flutter                                               |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| **Default Enabled**        | ❌ false                                                    | ❌ false                                              |
| **iOS Implementation**     | PLCrashReporter                                             | PLCrashReporter (same)                                |
| **Android Implementation** | ApplicationExitInfo                                         | ApplicationExitInfo (same)                            |
| **iOS Requirement**        | PLCrashReporter pod                                         | PLCrashReporter pod                                   |
| **Android Requirement**    | API 30+ (Android 11)                                        | API 30+ (Android 11)                                  |
| **Session Correlation**    | ✅ `crashedSessionId` (persisted, then read on next launch) | ❌ Not implemented                                    |
| **Error Type**             | `crash` (native)                                            | `crash` (native), `flutter_error` (ANR, FlutterError) |

The **Error Type** in both SDKs is `crash` for native errors but in React native the value change depending of the type of crash:

- `ANR: Application Not Responding`,
- `CRASH: Application crash (Java/Kotlin)`,
- `SIGTRAP: Trace/BPT trap` (iOS)

> **🔴 REVIEW NEEDED:** Regarding `ANR` in Flutter SDK is not sent as a `crash` type but as `flutter_error`. Should we update it?

---

### Session Correlation (React Native Only)

React Native persists the Faro session ID in native storage (UserDefaults on iOS, SharedPreferences on Android) when a session starts. When a crash occurs, the app terminates before telemetry is sent. On the next launch:

1. Native crash processing reads the **persisted** session ID (from the crashed session)
2. Includes it as `crashedSessionId` in the crash report
3. Enables correlation in Grafana: filter by `crashedSessionId` to see all events from the session where the crash happened

Flutter SDK does not implement this: iOS sends `meta.session` (the new session on restart); Android `ExitInfoHelper` does not persist or add session ID to crash reports.

---

## ANR Detection

### How Data is Collected

#### **React Native SDK**

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

#### **Flutter SDK**

**Android:**

- Similar watchdog pattern
- Monitors main thread responsiveness
- Configurable timeout

**iOS:**

- ❌ Not implemented

---

### Metric Format Sent to Faro

#### **React Native SDK**

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
    "description": "...",
    "crashedSessionId": "..."
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

#### **Flutter SDK**

Similar ANR error format with platform-specific details.

---

### Configuration

#### **React Native SDK**

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

#### **Flutter SDK**

```dart
Faro.initialize(
  optionsConfiguration: FaroConfig(
    // ANR tracking configuration
    // Check Flutter SDK docs for specific options
  ),
);
```

---

### Key Differences

| Aspect                   | React Native    | Flutter            |
| ------------------------ | --------------- | ------------------ |
| **Android Support**      | ✅ Yes          | ✅ Yes             |
| **iOS Support**          | ❌ No           | ❌ No              |
| **Default Enabled**      | ❌ false        | ❌ false           |
| **Configurable Timeout** | ✅ Yes          | Check Flutter docs |
| **Stack Trace Capture**  | ✅ Yes          | ✅ Yes             |
| **Detection Method**     | Watchdog thread | Similar watchdog   |

---

## App State

### How Data is Collected

#### **React Native SDK**

- Uses React Native's **AppState** API
- Subscribes to `change` events
- Maps RN states to Flutter AppLifecycleState names so both SDKs send the same state values
- Always enabled (no config flag)

**State mapping (RN → Flutter):**

- `active` → `resumed`
- `background` → `paused`
- `inactive` → `inactive`
- `unknown`/`extension` → `detached`

> **🔴 REVIEW NEEDED:** Is mapping RN state names to Flutter names really necessary? Both SDKs could keep their native state names (`active`/`background` vs `resumed`/`paused`) and still be queryable in Grafana. Consider reviewing this before committing to this mapping.

#### **Flutter SDK**

- Uses `WidgetsBindingObserver.didChangeAppLifecycleState` with `AppLifecycleState`
- Tracks: resumed, paused, inactive, detached, hidden

---

### Metric Format Sent to Faro

#### **React Native SDK**

```json
{
  "events": [
    {
      "name": "app_lifecycle_changed",
      "attributes": {
        "fromState": "resumed",
        "toState": "paused",
        "duration": "45000",
        "timestamp": "1678901234567"
      }
    }
  ]
}
```

**Sent via:** `faro.api.pushEvent('app_lifecycle_changed', { fromState, toState, duration, timestamp })`

#### **Flutter SDK**

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

### Key Differences

| Aspect               | React Native                                                   | Flutter                                                         |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| **API**              | AppState.addEventListener                                      | WidgetsBindingObserver (didChangeAppLifecycleState)             |
| **Always Enabled**   | ✅ Yes                                                         | ✅ Yes                                                          |
| **Event Name**       | `app_lifecycle_changed`                                        | `app_lifecycle_changed`                                         |
| **Event Attributes** | fromState, toState, duration, timestamp                        | fromState, toState ⚠️ No duration/timestamp                     |
| **State Names**      | resumed, paused, inactive, detached (RN maps to Flutter names) | resumed, paused, inactive, detached, hidden (AppLifecycleState) |

---

## Console Capture

### How Data is Collected

#### **React Native SDK**

- Patches `console.log`, `console.warn`, `console.error`, `console.debug`, `console.trace`
- **console.error**: By default sent as exception via `pushError()`; optionally as log via `consoleErrorAsLog`
- Other levels: Sent as logs via `pushLog()`
- Configurable: disable specific levels (default: debug, trace, log disabled to reduce noise)

#### **Flutter SDK**

- ❌ No direct equivalent (Dart `print`/`debugPrint` not patched)
- Logging typically via custom integrations

---

### Metric Format Sent to Faro

#### **React Native SDK**

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

### Configuration

#### **React Native SDK**

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

### Key Differences

| Aspect              | React Native          | Flutter          |
| ------------------- | --------------------- | ---------------- |
| **Console Capture** | ✅ Patches console.\* | ❌ No equivalent |
| **Default Enabled** | ✅ true               | N/A              |

---

## Error Reporting

### How Data is Collected

#### **React Native SDK**

- Patches **ErrorUtils** (React Native global) for unhandled JS errors
- Listens to **unhandledrejection** for promise rejections
- Parses stack traces (dev, release, Metro formats)
- Adds platform context (OS, Hermes)
- **Deduplication**: Same errors (identical message and stack) within a time window are not reported again. Default window: 5 seconds. Configurable via `enableDeduplication`, `deduplicationWindow`, and `maxDeduplicationEntries`.
- **Filtering**: `ignoreErrors` regex patterns
- **Error type and mechanism**: Aligned with Web SDK—uses actual JavaScript error type (TypeError, ReferenceError, etc.) and adds `mechanism` in context to indicate capture source (uncaught, unhandledrejection, console, crash, anr)

#### **Flutter SDK**

- Uses **FlutterError.onError** and **PlatformDispatcher.onError**
- Tracks unhandled Dart exceptions and zone errors
- Promise/future rejections via zone

---

### Metric Format Sent to Faro

#### **React Native SDK**

Each exception includes two classification dimensions:

- **`type`**: The semantic error kind (matches Web SDK)
  - JavaScript types: `TypeError`, `ReferenceError`, `RangeError`, `Error`, etc.
  - `UnhandledRejection` for promise rejections with non-Error values (primitives, plain objects)
  - `crash` for native crashes; `ANR` for Application Not Responding
- **`context.mechanism`**: Where the error was captured
  - `uncaught` — from ErrorUtils (unhandled JS)
  - `unhandledrejection` — from unhandled promise rejection
  - `console` — from console.error
  - `crash` — from native crash reporting
  - `anr` — from ANR detection

**Uncaught JavaScript error:**

```json
{
  "exceptions": [
    {
      "type": "TypeError",
      "value": "Cannot read property 'x' of undefined",
      "timestamp": "2024-01-15T10:25:33.000Z",
      "stacktrace": {
        "frames": [{ "filename": "App.tsx", "function": "handlePress", "lineno": 42, "colno": 12 }]
      },
      "context": {
        "mechanism": "uncaught",
        "platform": "ios",
        "hermes": "true"
      }
    }
  ]
}
```

**Unhandled promise rejection (Error):**

```json
{
  "exceptions": [
    {
      "type": "TypeError",
      "value": "Something went wrong",
      "context": { "mechanism": "unhandledrejection" }
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

### Configuration

#### **React Native SDK**

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

### Key Differences

| Aspect            | React Native                                                                                 | Flutter                           |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| **Source**        | ErrorUtils + unhandledrejection                                                              | FlutterError + PlatformDispatcher |
| **Error Type**    | Actual type (TypeError, ReferenceError, etc.); `UnhandledRejection` for primitive rejections | Often `flutter_error` bucket      |
| **Mechanism**     | `context.mechanism` (uncaught, unhandledrejection, console, crash, anr)                      | N/A                               |
| **Deduplication** | ✅ Fingerprint (message+stack), 5s window, configurable                                      | ❌ None                           |

---

## Session Management

### How Data is Collected

#### **React Native SDK**

- **SessionInstrumentation** manages session lifecycle
- **Volatile mode** (default): In-memory only; new session each app launch
- **Persistent mode** (optional): AsyncStorage; survives app restarts; 4h max, 15min inactivity timeout
- Events: `session_start`, `session_extend`, `session_resume`
- Auto-collects session attributes: device_id, device_os, device_model, RN version, etc.

#### **Flutter SDK**

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

`session_extend` is emitted when a **new session** is created because the previous one expired (inactivity or 4 h max), and the new session links to the old via `attributes.previousSession`. The old session is not extended; a fresh session ID is created. This lets backends treat the new session as continuing the same logical visit. Flutter does not emit `session_extend`.

**When it happens:** `session_extend` occurs when `updateSession` runs (e.g. on app foreground or before sending telemetry) while the app is **still in memory** and the session has expired. It does **not** occur when the app was killed and reopened after 4+ h — in that case the stored session is cleared before creating the new one, so no `previousSession` link exists and `session_start` is emitted instead.

### Using session_resume for Analytics

With persistent mode, `session_resume` supports questions like:

- **How many sessions end after a single foreground period?** — compare sessions with 1 event vs more
- **How often do users actually return within the same session?** — count `session_resume` per `session_start`

---

### Metric Format Sent to Faro

#### **React Native SDK**

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

### Configuration

#### **React Native SDK**

Sessions are always enabled. Options (via faro-core config):

- `sessionTracking.persistent`: Persist across restarts
- `sessionTracking.maxSessionPersistenceTime`: Max session age (ms)
- `sessionTracking.inactivityTimeout`: Inactivity before new session

---

### Key Differences

| Aspect                 | React Native                                        | Flutter                |
| ---------------------- | --------------------------------------------------- | ---------------------- |
| **Storage**            | Volatile: in-memory; Persistent: AsyncStorage       | No session persistence |
| **Session expiration** | 4 h max, 15 min inactivity                          | None                   |
| **Events**             | `session_start`, `session_resume`, `session_extend` | `session_start` only   |
| **Always enabled**     | Yes                                                 | Yes                    |

---

## User Actions

### How Data is Collected

#### **React Native SDK**

- **UserActionInstrumentation** subscribes to user action message bus
- **withFaroUserAction** HOC: Wraps TouchableOpacity, etc.; auto-tracks press/tap
- **trackUserAction()**: Manual API for custom actions
- **UserActionController**: Duration tracking, HTTP correlation, halt state for pending requests

#### **Flutter SDK**

- **FaroUserInteractionWidget** wraps app
- **pushEvent('user_interaction')**, **Faro().startSpan('user_action', ...)**
- HTTP correlation via trace context

---

### Metric Format Sent to Faro

#### **React Native SDK**

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

### Configuration

#### **React Native SDK**

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

### Key Differences

| Aspect               | React Native                               | Flutter                               |
| -------------------- | ------------------------------------------ | ------------------------------------- |
| **API**              | withFaroUserAction HOC + trackUserAction() | FaroUserInteractionWidget + startSpan |
| **HTTP Correlation** | ✅ Automatic                               | ✅ Via trace context                  |
| **Default Enabled**  | ✅ true                                    | Check Flutter docs                    |

---

## View / Screen Tracking

### How Data is Collected

#### **React Native SDK**

- **ViewInstrumentation** listens to meta changes
- Emits `view_changed` when screen name changes
- **useFaroNavigation** hook: Integrates with React Navigation; calls `ViewInstrumentation.setView(screenName)` on navigation
- Manual: `setView(name)` for non-React-Navigation apps

#### **Flutter SDK**

- **FaroNavigationObserver** for route tracking
- Similar view/screen change events

---

### Metric Format Sent to Faro

#### **React Native SDK**

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

### Configuration

#### **React Native SDK**

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

### Key Differences

| Aspect             | React Native                         | Flutter                |
| ------------------ | ------------------------------------ | ---------------------- |
| **Integration**    | useFaroNavigation (React Navigation) | FaroNavigationObserver |
| **Manual API**     | setView(name)                        | Check Flutter docs     |
| **Always Enabled** | ✅ Yes                               | ✅ Yes                 |

---

## Configuration Comparison

### Side-by-Side Configuration

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

  // User Data
  persistUser: true, // default: true
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

| Option               | React Native                 | Flutter                          | Notes                                                       |
| -------------------- | ---------------------------- | -------------------------------- | ----------------------------------------------------------- |
| **Basic Setup**      |
| URL                  | `url`                        | `url`                            | Collector endpoint (required when `enableTransports.fetch`) |
| App Name             | `app.name`                   | `appName`                        | Application name (required)                                 |
| App Version          | `app.version`                | `appVersion`                     | Version string                                              |
| Environment          | `app.environment`            | `appEnvironment`                 | Environment identifier                                      |
| **Transports**       |
| Offline Cache        | `enableTransports.offline`   | Check Flutter docs               | OfflineTransport when true                                  |
| Fetch                | `enableTransports.fetch`     | default                          | FetchTransport, requires url                                |
| Console (debug)      | `enableTransports.console`   | Check Flutter docs               | ConsoleTransport for Metro logs                             |
| **Performance**      |
| CPU Monitoring       | `cpuUsageVitals`             | `cpuUsageVitals`                 | Both default: true                                          |
| Memory Monitoring    | `memoryUsageVitals`          | `memoryUsageVitals`              | Both default: true                                          |
| Refresh Rate         | `refreshRateVitals`          | `refreshRateVitals`              | Both default: false                                         |
| Sampling Interval    | `fetchVitalsInterval` (ms)   | `fetchVitalsInterval` (Duration) | Different types                                             |
| Frame Options        | `frameMonitoringOptions` {}  | ❌ Not configurable              | RN has advanced options                                     |
| **Error Tracking**   |
| JS/Dart Errors       | `enableErrorReporting`       | `enableFlutterErrorReporting`    | Different naming                                            |
| Crash Reports        | `enableCrashReporting`       | `enableCrashReporting`           | Same                                                        |
| ANR Detection        | `anrTracking` + `anrOptions` | Check Flutter docs               | Android only                                                |
| **Console & User**   |
| Console Capture      | `enableConsoleCapture`       | Check Flutter docs               | ConsoleInstrumentation                                      |
| Console Options      | `consoleCaptureOptions`      | Check Flutter docs               | disabledLevels, serializeErrors, etc.                       |
| User Actions         | `enableUserActions`          | Check Flutter docs               | UserActionInstrumentation                                   |
| User Actions Options | `userActionsOptions`         | Check Flutter docs               | dataAttributeName, excludeItem                              |
| **Tracing**          |
| OpenTelemetry        | `enableTracing`              | Check Flutter docs               | TracingInstrumentation when true                            |
| **Network**          |
| URL Filtering        | `ignoreUrls` (RegExp[])      | `ignoreUrls` (String[])          | Different types                                             |
| **User Data**        |
| Persist User         | `persistUser`                | ❌ Check docs                    | RN-specific                                                 |

**React Native config model:** Flag-based. Pass `ReactNativeConfig` to `initializeFaro`; `makeRNConfig` builds instrumentations and transports from flags. No manual `getRNInstrumentations` or transport arrays needed.

---

## Threshold Proposals

### CPU Usage

**Recommended Thresholds:**

| Level        | Threshold | Color     | Description                                 |
| ------------ | --------- | --------- | ------------------------------------------- |
| **Normal**   | 0-50%     | 🟢 Green  | Healthy CPU usage                           |
| **Warning**  | 50-75%    | 🟡 Yellow | Elevated CPU usage, monitor for issues      |
| **Critical** | 75-100%   | 🟠 Orange | High CPU usage, may impact performance      |
| **Severe**   | >100%     | 🔴 Red    | Multi-core saturation, performance degraded |

**Grafana Query Example:**

```promql
# Average CPU usage over time
avg(faro_measurement_values{type="app_cpu_usage"})

# High CPU alert (>75% for 5 minutes)
avg_over_time(faro_measurement_values{type="app_cpu_usage"}[5m]) > 75
```

---

### Memory Usage

**Recommended Thresholds:**

| Device Type               | Normal | Warning   | Critical  | Severe |
| ------------------------- | ------ | --------- | --------- | ------ |
| **Low-end** (<2GB RAM)    | <150MB | 150-250MB | 250-400MB | >400MB |
| **Mid-range** (2-4GB RAM) | <200MB | 200-350MB | 350-500MB | >500MB |
| **High-end** (>4GB RAM)   | <300MB | 300-500MB | 500-800MB | >800MB |

**Color Coding:**

- 🟢 Green: Normal
- 🟡 Yellow: Warning
- 🟠 Orange: Critical
- 🔴 Red: Severe (likely OOM crashes)

**Grafana Query Example:**

```promql
# Memory usage in MB
faro_measurement_values{type="app_memory"} / 1024

# Memory spike alert (>500MB)
faro_measurement_values{type="app_memory"} / 1024 > 500
```

---

### Refresh Rate & Frames

**Refresh Rate Thresholds:**

| Level         | FPS Range | Color     | Description                   |
| ------------- | --------- | --------- | ----------------------------- |
| **Excellent** | 58-60 FPS | 🟢 Green  | Smooth, optimal performance   |
| **Good**      | 50-57 FPS | 🟡 Yellow | Minor drops, still acceptable |
| **Poor**      | 30-49 FPS | 🟠 Orange | Noticeable jank, investigate  |
| **Critical**  | <30 FPS   | 🔴 Red    | Severe performance issues     |

**Slow Frame Events:**

| Level        | Events/30s | Color     | Description               |
| ------------ | ---------- | --------- | ------------------------- |
| **Normal**   | 0-2        | 🟢 Green  | Minimal jank              |
| **Warning**  | 3-5        | 🟡 Yellow | Some performance issues   |
| **Critical** | 6-10       | 🟠 Orange | Frequent jank             |
| **Severe**   | >10        | 🔴 Red    | Severe rendering problems |

**Frozen Frames:**

| Level        | Count/30s | Duration/30s | Color     | Description        |
| ------------ | --------- | ------------ | --------- | ------------------ |
| **Normal**   | 0         | 0ms          | 🟢 Green  | No freezes         |
| **Warning**  | 1-2       | <500ms       | 🟡 Yellow | Occasional freezes |
| **Critical** | 3-5       | 500-1500ms   | 🟠 Orange | Frequent freezes   |
| **Severe**   | >5        | >1500ms      | 🔴 Red    | App appears frozen |

**Grafana Query Examples:**

```promql
# Current refresh rate
faro_measurement_values{type="app_refresh_rate"}

# Slow frame events per minute
rate(faro_measurement_values{type="app_frames_rate"}[1m]) * 60

# Frozen frame duration per minute
rate(faro_measurement_values{type="app_frozen_frame", value="frozen_duration"}[1m]) * 60
```

---

### Startup Time

**Recommended Thresholds:**

| Level         | Cold Start | Color     | Description                 |
| ------------- | ---------- | --------- | --------------------------- |
| **Excellent** | <1.5s      | 🟢 Green  | Very fast startup           |
| **Good**      | 1.5-3s     | 🟡 Yellow | Acceptable startup time     |
| **Poor**      | 3-5s       | 🟠 Orange | Slow, needs optimization    |
| **Critical**  | >5s        | 🔴 Red    | Very slow, user frustration |

**Grafana Query Examples:**

```promql
# Average cold start time (coldStart=1)
avg(faro_measurement_values{type="app_startup", coldStart="1"})

# Average warm start time (coldStart=0)
avg(faro_measurement_values{type="app_startup", coldStart="0"})

# P95 cold start time
histogram_quantile(0.95, faro_measurement_values{type="app_startup", coldStart="1"})
```

---

### ANR Detection

**Thresholds:**

| Level        | Condition     | Color     | Description            |
| ------------ | ------------- | --------- | ---------------------- |
| **Normal**   | 0 ANRs        | 🟢 Green  | No blocking detected   |
| **Warning**  | 1-2 ANRs/hour | 🟡 Yellow | Occasional blocking    |
| **Critical** | 3-5 ANRs/hour | 🟠 Orange | Frequent blocking      |
| **Severe**   | >5 ANRs/hour  | 🔴 Red    | App often unresponsive |

**Grafana Query Example:**

```promql
# ANR count per hour
# Note: React Native sends ANR as type="crash" (CrashReporting) or default type (ANRInstrumentation).
# Flutter sends ANR as type="flutter_error". Adjust label filter based on your collector/backend.
sum(increase(faro_errors_total{type="ANR"}[1h]))
```

**ANR Alert Examples:**

```logql
# ANR spike: >3 in 1 hour (LogQL / Loki)
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=ANR" [1h]) > 3

# ANR rate alert: >5 per hour sustained
sum(rate({app_id="YOUR_APP_ID", kind="exception"} |~ "type=ANR" [$__interval])) * 3600 > 5
```

---

### Crash Alerts

**Recommended Thresholds:**

| Level        | Crashes/Hour | Color     | Description                      |
| ------------ | ------------ | --------- | -------------------------------- |
| **Normal**   | 0            | 🟢 Green  | No native crashes                |
| **Warning**  | 1            | 🟡 Yellow | Single crash, investigate        |
| **Critical** | 2-5          | 🟠 Orange | Multiple crashes, prioritize fix |
| **Severe**   | >5           | 🔴 Red    | Crash storm, immediate attention |

**Alert Examples:**

```logql
# Any crash in last hour (LogQL / Loki)
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [1h]) >= 1

# Crash spike: >2 crashes in 15 minutes
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [15m]) > 2

# Crash rate per 1000 sessions (if sessions metric available)
sum(rate({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [1h])) / sum(rate({app_id="YOUR_APP_ID", kind="session"}[1h])) * 1000 > 1
```

---

### Normal Errors (JS/Dart Runtime)

**Recommended Thresholds:**

Non-crash exceptions (uncaught JS errors, FlutterError, promise rejections):

| Level        | Errors/Hour | Color     | Description                  |
| ------------ | ----------- | --------- | ---------------------------- |
| **Normal**   | 0-5         | 🟢 Green  | Minimal runtime errors       |
| **Warning**  | 5-20        | 🟡 Yellow | Elevated errors, review logs |
| **Critical** | 20-100      | 🟠 Orange | High error rate, likely bug  |
| **Severe**   | >100        | 🔴 Red    | Error storm, urgent fix      |

**Alert Examples:**

```logql
# Count normal errors (for dashboards; excludes crash/ANR)
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [$__auto]
)

# Normal error spike: >20 in 1 hour
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [1h]
) > 20

# Short-window spike: >50 errors in 15 minutes (possible cascading failure)
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [15m]
) > 50
```

---

## Real Log Examples

### CPU & Memory Measurements

#### **React Native SDK - Console Output**

```bash
[Faro] Performance monitoring started - collecting every 30000ms (memory: true, cpu: true)

# First collection (T=0s)
[Faro] Memory: pushing measurement with mem_usage = 98765.43
{
  "meta": {
    "sdk": {
      "name": "@grafana/faro-react-native",
      "version": "1.0.0"
    },
    "session": {
      "id": "abc-123-session",
      "attributes": {}
    }
  },
  "measurements": [
    {
      "type": "app_memory",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "values": {
        "mem_usage": 98765.43
      }
    }
  ]
}

[Faro] CPU: raw value = 0
[Faro] CPU: skipping - value is null or <= 0

# Second collection (T=30s)
[Faro] Memory: pushing measurement with mem_usage = 102341.56
[Faro] CPU: raw value = 23.45
[Faro] CPU: pushing measurement with cpu_usage = 23.45
{
  "measurements": [
    {
      "type": "app_memory",
      "timestamp": "2024-01-15T10:30:30.000Z",
      "values": {
        "mem_usage": 102341.56
      }
    },
    {
      "type": "app_cpu_usage",
      "timestamp": "2024-01-15T10:30:30.000Z",
      "values": {
        "cpu_usage": 23.45
      }
    }
  ]
}

# Third collection (T=60s) - High CPU
[Faro] Memory: pushing measurement with mem_usage = 105620.78
[Faro] CPU: raw value = 87.92
[Faro] CPU: pushing measurement with cpu_usage = 87.92
```

---

### Frame Monitoring

#### **React Native SDK - Android with Slow Frames**

```bash
[FrameMonitor] Frame monitoring started

# Slow frame detection
[Faro DEBUG ANDROID] 🐌 Slow frame detected: 45.2 FPS (target: 60.0)
[Faro DEBUG ANDROID] 🐌 Slow frame detected: 48.7 FPS (target: 60.0)
[Faro DEBUG ANDROID] 🐌 Slow frame detected: 52.1 FPS (target: 60.0)
# Frame recovers...
[Faro DEBUG ANDROID] ✅ COUNTED as event (78ms)! Total events now: 1

# More slow frames...
[Faro DEBUG ANDROID] 🐌 Slow frame detected: 38.5 FPS (target: 60.0)
[Faro DEBUG ANDROID] 🐌 Slow frame detected: 42.9 FPS (target: 60.0)
# Frame recovers...
[Faro DEBUG ANDROID] ✅ COUNTED as event (125ms)! Total events now: 2

# Frozen frame detection
[Faro DEBUG ANDROID] 🧊 SENDING frozen frame: count=1, duration=150ms

# Polling sends accumulated metrics (T=30s)
{
  "measurements": [
    {
      "type": "app_refresh_rate",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "values": {
        "refresh_rate": 59.8
      }
    },
    {
      "type": "app_frames_rate",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "values": {
        "slow_frames": 2
      }
    },
    {
      "type": "app_frozen_frame",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "values": {
        "frozen_frames": 1,
        "frozen_duration": 150.0
      }
    }
  ]
}
```

---

### Startup Time

#### **React Native SDK**

**Cold start** (app launch):

```bash
[StartupInstrumentation] Cold start metrics captured: 3840ms

{
  "measurements": [
    {
      "type": "app_startup",
      "timestamp": "2026-02-23T10:57:02.991Z",
      "values": {
        "appStartDuration": 3840,
        "coldStart": 1
      }
    }
  ]
}
```

**Warm start** (resume from background):

```bash
[StartupInstrumentation] Warm start metrics captured: 85ms

{
  "measurements": [
    {
      "type": "app_startup",
      "timestamp": "2026-02-23T10:58:15.123Z",
      "values": {
        "appStartDuration": 85,
        "coldStart": 0
      }
    }
  ]
}
```

**Grafana Alloy faro receiver log format:**

```text
timestamp=2026-02-23T10:57:02.991Z kind=measurement level=info type=app_startup appStartDuration=3840 coldStart=1 value_appStartDuration=3840 value_coldStart=1
```

---

### Crash Report

#### **React Native SDK - iOS PLCrashReporter**

```bash
# On app restart after crash
[FaroCrashReporter] Checking for crash reports...
[FaroCrashReporter] Found 1 pending crash report

{
  "exceptions": [
    {
      "type": "crash",
      "value": "SIGSEGV: Segmentation fault",
      "stacktrace": {
        "frames": [
          {
            "filename": "SomeNativeModule.m",
            "function": "processData",
            "lineno": 145,
            "colno": 12
          },
          {
            "filename": "AppDelegate.m",
            "function": "application:didFinishLaunchingWithOptions:",
            "lineno": 67,
            "colno": 5
          }
        ]
      },
      "timestamp": "2024-01-15T10:25:33.000Z"
    }
  ],
  "meta": {
    "session": {
      "id": "crashed-session-id-xyz",
      "attributes": {
        "crashedSessionId": "crashed-session-id-xyz",
        "platform": "iOS",
        "osVersion": "17.2"
      }
    }
  }
}

[FaroCrashReporter] Purged crash reports
```

---

### ANR Detection

#### **React Native SDK - Android**

```bash
[ANRTracker] Starting ANR tracking with timeout: 5000ms

# Main thread blocked
[ANRTracker] Main thread not responding for 5234ms
[ANRTracker] ANR detected! Capturing stack trace...

# In-session ANR (ANRInstrumentation) — type uses default, not "crash".
# For system-killed ANR (CrashReporting), see "Metric Format Sent to Faro" above.
{
  "exceptions": [
    {
      "type": "Error",
      "value": "ANR (Application Not Responding)",
      "stacktrace": {
        "frames": [
          {
            "filename": "MainActivity.kt",
            "function": "processLargeFile",
            "lineno": 234
          },
          {
            "filename": "FileProcessor.kt",
            "function": "readAllLines",
            "lineno": 89
          }
        ]
      },
      "timestamp": "2024-01-15T10:30:15.000Z"
    }
  ],
  "meta": {
    "session": {
      "attributes": {
        "timeout": 5000,
        "actualDuration": 5234,
        "platform": "Android"
      }
    }
  }
}
```

---

### HTTP Request Instrumentation

#### **React Native SDK**

Uses **events** with `event_name=faro.tracing.fetch` (Web SDK format) for Grafana Frontend Observability and HTTP insights compatibility.

```bash
# Successful request - faro.tracing.fetch event
{
  "events": [
    {
      "name": "faro.tracing.fetch",
      "attributes": {
        "http.url": "https://api.example.com/users",
        "http.method": "GET",
        "http.scheme": "https",
        "http.host": "api.example.com",
        "http.status_code": "200",
        "http.request_size": "0",
        "http.response_size": "1234",
        "duration_ns": "234560000"
      }
    }
  ]
}

# Failed request (network error) - faro.tracing.fetch event with status_code=0
{
  "events": [
    {
      "name": "faro.tracing.fetch",
      "attributes": {
        "http.url": "https://api.example.com/orders",
        "http.method": "POST",
        "http.scheme": "https",
        "http.host": "api.example.com",
        "http.status_code": "0",
        "http.error": "Network error",
        "duration_ns": "5123450000"
      }
    }
  ],
  "exceptions": [
    {
      "type": "HTTP Request Failed",
      "value": "Network error",
      "timestamp": "2024-01-15T10:30:10.000Z"
    }
  ]
}
```

**Loki query** for HTTP errors (status 4xx/5xx or network failure):

```logql
count_over_time({app_id="YOUR_APP_ID", kind="event"}
  |= "event_name=faro.tracing.fetch"
  | logfmt
  | (event_data_http_status_code >= 400 and event_data_http_status_code < 600) or event_data_http_status_code = 0
  [$__auto])
```

---

### App State

#### **React Native SDK**

```bash
# User switches to another app (app goes to background)
[Faro] App state changed { from: 'active', to: 'background', duration: 45000 }

{
  "events": [
    {
      "name": "app_lifecycle_changed",
      "attributes": {
        "fromState": "resumed",
        "toState": "paused",
        "duration": "45000",
        "timestamp": "1678901234567"
      }
    }
  ],
  "meta": { "session": { "id": "abc-123" }, "app": {} }
}

# User returns to app (app comes to foreground)
[Faro] App returned to foreground { duration: 120000 }

{
  "events": [
    {
      "name": "app_lifecycle_changed",
      "attributes": {
        "fromState": "paused",
        "toState": "resumed",
        "duration": "120000",
        "timestamp": "1678901354567"
      }
    }
  ]
}
```

---

### Console Capture

#### **React Native SDK**

```bash
# console.log (when level not disabled)
{
  "logs": [
    {
      "level": "info",
      "message": ["User opened settings"],
      "timestamp": "2024-01-15T10:25:33.000Z"
    }
  ]
}

# console.warn
{
  "logs": [
    {
      "level": "warn",
      "message": ["Deprecated API used: oldMethod"],
      "timestamp": "2024-01-15T10:25:34.000Z"
    }
  ]
}

# console.error (sent as exception when consoleErrorAsLog: false)
{
  "exceptions": [
    {
      "type": "Error",
      "value": "console.error: Failed to fetch user data",
      "stacktrace": {
        "frames": [
          { "filename": "UserService.ts", "function": "fetchUser", "lineno": 42 }
        ]
      },
      "timestamp": "2024-01-15T10:25:35.000Z"
    }
  ]
}
```

---

### Error Reporting

#### **React Native SDK - Uncaught JS Error**

```bash
# Unhandled JavaScript error (mechanism: uncaught)
{
  "exceptions": [
    {
      "type": "TypeError",
      "value": "Cannot read property 'id' of undefined",
      "timestamp": "2024-01-15T10:25:33.000Z",
      "stacktrace": {
        "frames": [
          { "filename": "ProfileScreen.tsx", "function": "renderUser", "lineno": 28, "colno": 12 },
          { "filename": "App.tsx", "function": "App", "lineno": 15 }
        ]
      },
      "context": {
        "mechanism": "uncaught",
        "platform": "ios",
        "hermes": "true"
      }
    }
  ]
}
```

#### **React Native SDK - Unhandled Promise Rejection (Error)**

```bash
# Promise rejection with Error (mechanism: unhandledrejection, type from error.name)
{
  "exceptions": [
    {
      "type": "Error",
      "value": "Network request failed",
      "timestamp": "2024-01-15T10:25:40.000Z",
      "context": {
        "mechanism": "unhandledrejection",
        "cause": "Failed to fetch"
      }
    }
  ]
}
```

#### **React Native SDK - Unhandled Promise Rejection (primitive)**

```bash
# Promise rejection with non-Error value (type: UnhandledRejection)
{
  "exceptions": [
    {
      "type": "UnhandledRejection",
      "value": "Unhandled Promise Rejection: String rejection",
      "context": { "mechanism": "unhandledrejection" }
    }
  ]
}
```

---

### Session Management

#### **React Native SDK**

```bash
# App launch - new session start
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
        "device_id": "device-uuid-xyz",
        "device_os": "iOS",
        "device_os_detail": "17.2",
        "device_model_name": "iPhone 15"
      }
    }
  }
}

# Session extended (user returns within 15min inactivity window)
{
  "events": [
    {
      "name": "session_extend",
      "attributes": {}
    }
  ]
}
```

---

### User Actions

#### **React Native SDK**

```bash
# User taps button (withFaroUserAction HOC)
[Faro] User action started: button_pressed

# Action ends after ~100ms inactivity (or when HTTP completes)
{
  "events": [
    {
      "name": "user_action",
      "attributes": {
        "name": "button_pressed",
        "duration": "250",
        "trigger_name": "press"
      }
    }
  ]
}
```

---

### View / Screen Tracking

#### **React Native SDK - React Navigation**

```bash
# User navigates from Home to Profile
[Faro] View instrumentation initialized

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

## Feature Parity Matrix

### Complete Feature Comparison

| Feature                    | React Native                                            | Flutter                                     | Notes                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Performance Monitoring** |
| CPU Usage                  | ✅ Per-process (iOS)                                    | ⚠️ System-wide (iOS)                        | RN more accurate                                                                                                                                                      |
| Memory Usage               | ✅ phys_footprint (iOS)                                 | ⚠️ resident_size (iOS)                      | RN uses Apple-recommended metric                                                                                                                                      |
| Refresh Rate               | ✅ With ProMotion                                       | ✅ With ProMotion                           | Both support high-refresh displays                                                                                                                                    |
| Slow Frames                | ✅ Event-based grouping (iOS & Android)                 | ✅ Count-based (Android only)               | RN groups consecutive frames                                                                                                                                          |
| Frozen Frames              | ✅ Count + duration (iOS & Android)                     | ✅ Count only (Android only)                | RN tracks duration                                                                                                                                                    |
| Frame Monitoring Config    | ✅ Extensive options                                    | ❌ Minimal                                  | RN more configurable                                                                                                                                                  |
| **Startup Metrics**        |
| Cold Start Time            | ✅ iOS & Android                                        | ✅ iOS & Android                            | Identical implementation                                                                                                                                              |
| Warm Start Time            | ✅ iOS & Android                                        | ✅ iOS & Android                            | Both via AppState/lifecycle                                                                                                                                           |
| **Error & Crash**          |
| JavaScript/Dart Errors     | ✅ ErrorUtils patch                                     | ✅ FlutterError.onError                     | Platform-specific                                                                                                                                                     |
| Promise Rejections         | ✅ Tracked                                              | ✅ Tracked                                  | Both handle unhandled rejections                                                                                                                                      |
| Crash Reporting (iOS)      | ✅ PLCrashReporter                                      | ✅ PLCrashReporter                          | Same implementation                                                                                                                                                   |
| Crash Reporting (Android)  | ✅ ApplicationExitInfo                                  | ✅ ApplicationExitInfo                      | Same (API 30+)                                                                                                                                                        |
| ANR Detection              | ✅ Android only                                         | ✅ Android only                             | Watchdog-based                                                                                                                                                        |
| Error Deduplication        | ✅ Fingerprint (message+stack), 5s window, configurable | ❌ None                                     | RN: message+stack fingerprint, time window                                                                                                                            |
| **Network Monitoring**     |
| Fetch API                  | ✅ Automatic                                            | N/A (no fetch in Flutter)                   | RN: faro.tracing.fetch events (Web SDK format)                                                                                                                        |
| XMLHttpRequest / axios     | ✅ Automatic                                            | N/A                                         | RN: both fetch and XHR tracked                                                                                                                                        |
| Request/Response Size      | ✅ Tracked                                              | ✅ Tracked                                  | Both capture sizes                                                                                                                                                    |
| URL Filtering              | ✅ RegExp array                                         | ✅ String array                             | Different filter types                                                                                                                                                |
| **Session Management**     |
| Session Tracking           | ✅ AsyncStorage                                         | ✅ SharedPreferences                        | Platform storage                                                                                                                                                      |
| Session Persistence        | ✅ Survives restarts                                    | ✅ Survives restarts                        | Both persist sessions                                                                                                                                                 |
| Session Timeout            | ✅ 4h max / 15min inactivity                            | ❌ None (app process lifetime)              | RN: configurable; Flutter: no timeout                                                                                                                                 |
| Session Attributes         | ✅ Auto-collected                                       | ✅ Auto-collected                           | Device, OS, version                                                                                                                                                   |
| **User Actions**           |
| User Action Tracking       | ✅ HOC + manual API                                     | ✅ FaroUserInteractionWidget + manual spans | RN: withFaroUserAction HOC + trackUserAction(); Flutter: wrap app with FaroUserInteractionWidget, pushEvent('user_interaction'), Faro().startSpan('user_action', ...) |
| HTTP Correlation           | ✅ Automatic                                            | ✅ Via trace context                        | RN: UserActionController + httpRequestMonitor; Flutter: HTTP span inherits active span, trace_id/span_id in http_request event                                        |
| **Navigation**             |
| React Navigation           | ✅ Built-in support                                     | N/A                                         | RN-specific                                                                                                                                                           |
| Screen Tracking            | ✅ ViewInstrumentation                                  | ✅ Route tracking                           | Platform-specific                                                                                                                                                     |
| **Platform Support**       |
| iOS                        | ✅ 13.4+                                                | ✅ 11.0+                                    | RN: newer minimum; Flutter: iOS 11+ (faro.podspec)                                                                                                                    |
| Android                    | ✅ API 21+                                              | ✅ API 19+                                  | RN: API 21; Flutter: minSdkVersion 19 (build.gradle)                                                                                                                  |
| **Configuration**          |
| Type Safety                | ✅ TypeScript                                           | ✅ Dart                                     | Strong typing both                                                                                                                                                    |
| Default Config             | ✅ Sensible defaults                                    | ✅ Sensible defaults                        | Both production-ready                                                                                                                                                 |
| Extensibility              | ✅ Custom instrumentations                              | ✅ Custom integrations                      | Both extensible                                                                                                                                                       |

---

## Missing Features & Roadmap

### React Native SDK - Planned Features

#### **High Priority**

1. **Web Vitals Equivalent for Mobile**
   - Time to First Contentful Paint (FCP)
   - Time to Interactive (TTI)
   - First Input Delay (FID)

2. **Better Error Source Maps Support**
   - Symbolication for production builds
   - Source map upload tooling
   - Better stack trace resolution

3. **Network Request Body Sanitization**
   - Remove sensitive data from request bodies
   - Configurable sanitization rules
   - PII detection and filtering

4. **Custom User Actions API**
   - Enhanced manual tracking
   - Action composition and nesting
   - Better correlation with business metrics

#### **Medium Priority**

5. **iOS ANR Detection**
   - Main thread watchdog for iOS
   - Different from Android implementation
   - iOS-specific hangs detection

6. **Battery Usage Tracking**
   - Monitor battery drain
   - Correlate with performance metrics
   - iOS: Use IOKit, Android: BatteryManager

7. **Network Connection Quality**
   - Track connection type (WiFi, 4G, 5G)
   - Monitor connection changes
   - Correlate performance with network quality

8. **Disk Usage Monitoring**
   - Track available storage
   - Monitor cache size growth
   - Alert on low storage conditions

9. **React Native Hermes Profiling**
   - Better Hermes engine integration
   - JavaScript heap profiling
   - Hermes-specific metrics

#### **Low Priority / Future**

10. **Offline Queue Management**
    - Better offline telemetry storage
    - Configurable queue limits
    - Smart retry logic

11. **A/B Testing Integration**
    - Tag sessions with experiment variants
    - Compare metrics across variants
    - Built-in A/B test support

12. **Custom Metrics API**
    - User-defined measurements
    - Business metric tracking
    - Custom aggregations

---

### Flutter SDK - Areas to Watch

Based on the comparison, Flutter SDK may want to consider:

1. **Improve iOS CPU Monitoring**
   - Switch from system-wide to per-process calculation
   - Match React Native's accurate implementation

2. **Use Apple-Recommended Memory Metric**
   - Switch from `resident_size` to `phys_footprint`
   - Better correlation with Xcode tools

3. **Improve Slow Frame Detection (Android)**
   - Consider event-based grouping (like RN) instead of raw count
   - Filter noise with minimum duration threshold

4. **Improve Frozen Frame Detection**
   - Add `frozen_duration` alongside count (Android)
   - iOS: Add frozen/slow frame support (currently Android only)

5. **Expand Frame Monitoring Configuration**
   - Make thresholds configurable
   - Allow customization per use case

---

## Best Practices

### General Recommendations

1. **Start with Defaults**
   - Both SDKs have sensible defaults
   - Enable features gradually
   - Monitor impact on app performance

2. **Monitor in Staging First**
   - Test telemetry volume
   - Verify data accuracy
   - Check performance impact

3. **Use Feature Flags**
   - Control monitoring features remotely
   - Gradual rollout to users
   - Quick disable if issues arise

4. **Set Up Alerts**
   - Use threshold recommendations
   - Alert on anomalies
   - Page on critical issues

5. **Correlate Metrics**
   - High CPU + High memory = investigate
   - Slow frames + Network issues = poor UX
   - Crashes + Specific device = hardware issue

### SDK-Specific Recommendations

#### **React Native**

- Enable `refreshRateVitals` only when investigating UI performance
- Use `frameMonitoringOptions` to tune detection sensitivity
- Monitor slow frame events (not individual frames) for better signal
- Keep `fetchVitalsInterval` at 30s unless you need higher resolution

#### **Flutter**

- Be aware of iOS CPU measurement limitations
- Consider memory unit differences between iOS/Android
- Basic refresh rate monitoring may be sufficient for most apps

---

## Conclusion

Both Faro React Native and Flutter SDKs provide comprehensive mobile RUM capabilities with strong feature parity. Key takeaways:

**React Native SDK Strengths:**

- More accurate iOS CPU monitoring (per-process)
- Apple-recommended memory metric (`phys_footprint`)
- Advanced frame monitoring with slow/frozen frame detection
- Highly configurable frame monitoring options
- Event-based jank detection filters noise effectively

**Flutter SDK Strengths:**

- Mature, production-tested implementation
- Clean Dart API with strong typing
- Good documentation and examples
- Works well for basic monitoring needs

**Recommendation:**

- **For new projects**: Choose based on your app framework (React Native vs Flutter)
- **For advanced frame monitoring**: React Native SDK has more features
- **For basic monitoring**: Both SDKs are excellent choices
- **For maximum accuracy**: React Native iOS CPU monitoring is superior

Both SDKs continue to evolve, and feature parity improvements are ongoing. Check the latest documentation for updates.

---

## Additional Resources

- [Faro React Native SDK GitHub](https://github.com/grafana/faro-react-native-sdk)
- [Faro Flutter SDK GitHub](https://github.com/grafana/faro-flutter-sdk)
- [Grafana Faro Documentation](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/)
- [React Native SDK README](./packages/react-native/README.md)
- [Contributing Guidelines](./CONTRIBUTING.md)

---

**Document Version:** 1.1.0  
**Last Updated:** 2025-02-20  
**Maintained by:** Grafana Faro Team

**Changelog (v1.1.0):** Updated React Native config examples to flag-based model using `makeRNConfig`; added `enableTransports`, `enableTracing`, `consoleCaptureOptions`, `userActionsOptions`; removed manual `getRNInstrumentations` usage.
