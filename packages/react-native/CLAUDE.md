# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## Package Overview

`@grafana/faro-react-native` is the core SDK package providing instrumentations, metas, and transports for React Native applications.

**Main exports** (see `src/index.ts`):

- `initializeFaro()` - SDK initialization
- `getRNInstrumentations()` - Default instrumentation bundle
- Individual instrumentations (ErrorsInstrumentation, ConsoleInstrumentation, etc.)
- React components (FaroErrorBoundary, withFaroUserAction, etc.)
- Transports (FetchTransport, ConsoleTransport)
- Metas (device, screen, SDK)
- Navigation utilities (useFaroNavigation, ReactNativeNavigationIntegration)

## Commands

```bash
# Run tests
yarn quality:test

# Run tests in watch mode
yarn quality:test --watch

# Run specific test file
npx jest src/instrumentations/errors/instrumentation.test.ts

# Build (CJS + ESM + types)
yarn build

# Watch mode (development)
yarn watch

# Lint
yarn quality:lint

# Format code
yarn quality:format

# Check circular dependencies
yarn quality:circular-deps
```

## Directory Structure

```
src/
├── config/                    # SDK configuration
│   ├── getRNInstrumentations.ts   # Default instrumentation bundle
│   └── types.ts                    # Config TypeScript types
├── errorBoundary/             # React error boundary components
├── instrumentations/          # Core instrumentations
│   ├── appState/              # App foreground/background tracking
│   ├── console/               # Console log capture
│   ├── errors/                # Error and promise rejection tracking
│   ├── http/                  # HTTP request instrumentation
│   ├── performance/           # CPU/memory monitoring (native)
│   ├── session/               # Session management with AsyncStorage
│   ├── startup/               # App startup time (native)
│   ├── userActions/           # User interaction tracking
│   └── view/                  # Screen/navigation tracking
├── metas/                     # Metadata providers
│   ├── device.ts              # Device information
│   ├── page.ts                # Page/screen meta
│   ├── screen.ts              # Screen tracking
│   └── sdk.ts                 # SDK version info
├── navigation/                # React Navigation integration
├── transports/                # Transport implementations
│   ├── console/               # Console debug transport
│   └── fetch/                 # HTTP transport to Faro collector
└── initialize.ts              # Main initialization logic
```

## Architecture Patterns

### Instrumentation Lifecycle

All instrumentations extend `BaseInstrumentation` from `@grafana/faro-core`:

```typescript
export class MyInstrumentation extends BaseInstrumentation {
  readonly name = '@grafana/faro-react-native:instrumentation-name';
  readonly version = VERSION;

  initialize(): void {
    // Called by Faro during initializeFaro()
    // Set up listeners, patch globals, etc.
  }

  unpatch(): void {
    // Optional cleanup
    // Restore original APIs, remove listeners
  }
}
```

**Critical patterns:**

1. Store references to original APIs before patching
2. Use `this.api` to access Faro API (pushEvent, pushLog, pushError, etc.)
3. Use `this.logDebug()` / `this.logInfo()` for internal logging (never console.log)
4. Handle missing globals gracefully (check if API exists before patching)

### Session Management

Sessions are managed by `SessionInstrumentation` with two modes:

**Persistent (AsyncStorage):**

- Sessions survive app restarts
- Expire after 4 hours of inactivity
- Timeout after 15 minutes of inactivity

**Volatile (in-memory):**

- New session each app launch
- No storage overhead

**Session attributes** are automatically collected via `getSessionAttributes()`:

- Device OS, version, manufacturer, model
- React Native version
- Device type (phone/tablet)
- Emulator detection
- SDK version

### User Actions System

User actions track user interactions and correlate them with HTTP requests and errors.

**Two APIs:**

1. **HOC (Recommended):**

```typescript
const TrackedButton = withFaroUserAction(TouchableOpacity, 'action_name');
```

- Automatically starts action on press
- Tracks HTTP requests triggered during action
- Ends action after ~100ms of inactivity
- Enters "halt" state if HTTP pending (waits up to 10s)

2. **Manual API:**

```typescript
const action = trackUserAction('action_name', { context });
// ... do work
action?.end();
```

**HTTP Correlation:**
`HttpInstrumentation` checks if a user action is active and adds correlation metadata.

### Error Handling

`ErrorsInstrumentation` patches React Native's `ErrorUtils`:

- Captures unhandled errors
- Captures promise rejections
- Parses React Native stack traces (multiple formats)
- Deduplicates errors (configurable window)
- Filters errors by regex patterns

**Stack trace parsing** handles:

- Dev mode: `at functionName (file.js:123:45)`
- Release: `functionName@123:456`
- Native: `at functionName (native)`
- Metro: `at Object.functionName (/path/to/file.js:123:456)`

### Error Type Conventions

When pushing errors via `faro.api.pushError()`, follow these type conventions:

**Guideline:** Avoid hardcoded generic types like `flutter_error` or `react_native_error`. Instead:

1. **Get the real error type** from the error object when available (e.g., `TypeError`, `ReferenceError`, `NetworkError`)
2. **Default to `Error`** if no specific type can be determined
3. **Keep ANR and Crash as explicit separate types:**
   - `ANR` - Application Not Responding events
   - `Crash` - Native crash reports from previous sessions

**Rationale:** The Flutter SDK currently uses `flutter_error` as a broad bucket for multiple error sources (FlutterError.onError, PlatformDispatcher.onError, etc.), which loses specificity. The Faro Web SDK avoids this by extracting the actual error type. React Native should follow the Web SDK pattern for consistency and better error categorization in Grafana.

**Example:**

```typescript
// ✅ Good - use actual error type
const errorType = error.name || error.constructor?.name || 'Error';
this.api.pushError(error, { type: errorType });

// ✅ Good - explicit types for special cases
this.api.pushError(error, { type: 'ANR' });      // For ANR events
this.api.pushError(error, { type: 'Crash' });   // For crash reports

// ❌ Bad - generic bucket type
this.api.pushError(error, { type: 'react_native_error' });
```

### Transport System

Transports implement batched sending with circuit breaker:

**FetchTransport:**

- Batches items (default: 30 items or buffer full)
- Respects 429 rate limiting
- Circuit breaker after 3 consecutive failures
- 30-second backoff when offline
- Automatically filters collector URLs from HttpInstrumentation

**ConsoleTransport:**

- Logs telemetry to console for debugging
- Configurable log level
- Shows full metadata structure

**Critical:** Both transports must handle failures silently to prevent infinite loops.

## Native Modules

### Performance Instrumentation

Uses native code for accurate metrics:

**iOS (`ios/FaroReactNative.swift`):**

- CPU: `host_statistics()` with differential calculation
- Memory: `task_info()` for RSS
- Returns values in milliseconds/kilobytes

**Android (`android/src/main/java/com/grafana/faro/reactnative/`):**

- CPU: Parses `/proc/[pid]/stat`
- Memory: Parses `/proc/[pid]/status` for VmRSS
- Currently blocked by workspace gradle issues (code is ready)

### Startup Instrumentation

Measures app startup time from process start:

**iOS (`ios/FaroReactNative.swift`):**

- Uses `sysctl()` with `KERN_PROC_PID` to query process start time
- Returns milliseconds since process start

**Android (`android/`):**

- Uses `Process.getStartElapsedRealtime()` (API 24+)
- Currently blocked by workspace gradle issues (code is ready)

**Native module configuration:**

- `react-native.config.js` enables autolinking
- `FaroReactNative.podspec` configures iOS pod
- Forces Old Architecture mode (no TurboModule/Fabric)

## Testing Practices

### Test File Organization

Co-locate tests with implementation:

```
src/instrumentations/errors/
├── index.ts
├── instrumentation.test.ts
├── stackTraceParser.ts
└── stackTraceParser.test.ts
```

### Common Test Patterns

**Testing instrumentations:**

```typescript
describe('MyInstrumentation', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new MyInstrumentation()],
      })
    );
  });

  it('should capture event', () => {
    // Trigger behavior
    triggerEvent();

    // Assert telemetry sent
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0].payload.name).toBe('expected_event');
  });
});
```

**Testing React components:**

```typescript
import { render, fireEvent } from '@testing-library/react-native';

it('should track user action', () => {
  const mockPushEvent = jest.fn();
  faro.api.pushEvent = mockPushEvent;

  const { getByText } = render(<MyComponent />);
  fireEvent.press(getByText('Button'));

  expect(mockPushEvent).toHaveBeenCalledWith('action_name', expect.any(Object));
});
```

**Testing time-based behavior:**

```typescript
it('should timeout after delay', () => {
  jest.useFakeTimers();

  // Trigger behavior
  startTimer();

  // Advance time
  jest.advanceTimersByTime(5000);

  // Assert
  expect(timeoutOccurred()).toBe(true);

  jest.useRealTimers();
});
```

### Test Utilities

Use `@grafana/faro-test-utils` for mocks:

- `mockConfig()` - Creates test Faro config
- `MockTransport` - Captures telemetry items
- `mockInternalLogger` - Mock logger

## React Navigation Integration

Two integration approaches:

**1. Hook (Recommended):**

```typescript
import { useFaroNavigation } from '@grafana/faro-react-native';

function App() {
  const navigationRef = useNavigationContainerRef();
  useFaroNavigation(navigationRef);
  return <NavigationContainer ref={navigationRef}>...</NavigationContainer>;
}
```

**2. Manual:**

```typescript
import { onNavigationStateChange } from '@grafana/faro-react-native';

<NavigationContainer onStateChange={onNavigationStateChange}>
```

**Integration works by:**

1. Listening to navigation state changes
2. Extracting current route name
3. Calling `ViewInstrumentation.setView(screenName)`
4. Emitting navigation event with route params

## Code Style

### Defensive Programming

Always check for null/undefined - never use `!`:

```typescript
// ❌ Bad
const value = object.property!.nested!;

// ✅ Good
if (object?.property?.nested) {
  const value = object.property.nested;
}
```

### Error Handling

Instrumentations must never throw - catch and log internally:

```typescript
try {
  // risky operation
} catch (error) {
  this.logDebug('Operation failed', { error });
  // Continue gracefully
}
```

### Performance Considerations

- Use throttling for high-frequency events (see `src/utils/throttle.ts`)
- Batch telemetry items when possible
- Avoid synchronous heavy operations in hot paths
- Clean up listeners and timers in `unpatch()`

## Common Maintenance Tasks

### Adding a New Instrumentation

1. Create directory: `src/instrumentations/my-feature/`
2. Implement class extending `BaseInstrumentation`
3. Add tests co-located with implementation
4. Export from `src/index.ts`
5. Add to `getRNInstrumentations()` if it should be included by default
6. Document in main README.md

### Updating @grafana/faro-core

**Be very careful** - we're pinned to 2.0.2 for stability:

1. Check changelog for breaking changes
2. Update version in package.json
3. Run full test suite: `yarn quality:test`
4. Test demo app on both iOS and Android
5. Update any types that changed
6. Document migration if breaking changes

### Debugging Native Modules

**iOS:**

```bash
# Enable native logging
cd demo
npx react-native log-ios

# Clean build
cd ios
rm -rf Pods Podfile.lock
pod install
cd ..
yarn ios
```

**Android:**

```bash
# View native logs
npx react-native log-android

# Currently blocked by workspace gradle issues
# Native code is complete and ready
```

## API Stability Guarantees

Public APIs (exported from `src/index.ts`) follow semver:

- Breaking changes require major version bump
- New features require minor version bump
- Bug fixes require patch version bump

Internal APIs (not exported) can change without version bump.
