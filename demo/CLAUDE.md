# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## Overview

This is the demo application showcasing the Grafana Faro React Native SDK. It demonstrates all core features including instrumentations, user actions, error tracking, performance monitoring, and distributed tracing.

## Commands

```bash
# Start Metro bundler
yarn start

# Run on iOS
yarn ios

# Run on Android
yarn android

# Install iOS dependencies
cd ios && pod install && cd ..

# Clean Metro cache
yarn start --reset-cache

# Clean iOS build
cd ios && rm -rf build && cd ..
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and add your Faro collector URL:

```bash
FARO_COLLECTOR_URL=https://faro-collector-prod-YOUR-REGION.grafana.net/collect/YOUR_TOKEN_HERE
```

The `.env` file is gitignored to prevent accidentally committing credentials.

### Faro Initialization

See `src/faro/initialize.ts` for complete Faro setup:

- All instrumentations enabled
- Console transport for debugging
- Custom error serialization
- Session tracking with AsyncStorage persistence

## Architecture

### Navigation Structure

```
App.tsx
  └─ NavigationContainer
      └─ Stack Navigator
          ├─ HomeScreen (tabs)
          │   ├─ Home Tab
          │   ├─ Error Demo Tab
          │   ├─ Performance Tab
          │   ├─ Tracing Tab
          │   └─ Device Info Tab
          └─ About Screen (modal)
```

### Faro Integration Points

**Initialization (`src/faro/initialize.ts`):**

- Initializes Faro with all instrumentations
- Configured to use source files via `link:` dependency
- Hot reload friendly (checks if already initialized)

**Navigation Integration (`App.tsx`):**

- Uses `useFaroNavigation()` hook
- Automatically tracks screen changes
- Emits navigation events with route params

**User Action Tracking:**

- HOC-wrapped buttons throughout the app
- Each button has custom action name and context
- Automatically correlates with HTTP requests

**Error Demonstration:**

- Sync/async errors
- Promise rejections
- Console errors
- Shows error boundary in action

**Performance Tracking:**

- Manual measurements via `faro.api.pushMeasurement()`
- Native performance monitoring (CPU/memory)
- Startup time tracking

**Tracing Demo:**

- 10 comprehensive scenarios
- Automatic fetch tracing
- Manual span creation
- Nested spans
- Error correlation

## Development Workflow

### Making Changes to SDK

The demo uses source files directly via `"link:../packages/react-native"` dependency:

1. Make changes in `packages/react-native/src/`
2. Changes are immediately reflected (no rebuild needed)
3. Hot reload works as expected
4. TypeScript errors show up in Metro

**If you need to test built code:**

```bash
# From root
yarn build

# Update demo dependency to use dist
cd demo
# Edit package.json to remove link:
"@grafana/faro-react-native": "^1.0.0"
yarn install
```

### Testing Native Changes

**iOS native module changes:**

```bash
cd ios
pod install
cd ..
yarn ios  # Full rebuild
```

**Android native module changes:**

```bash
yarn android  # Full rebuild
```

### Metro Configuration

See `metro.config.js` - configured to:

- Watch monorepo packages for changes
- Resolve `react` and `react-native` from both demo and root
- Handle workspace symlinks correctly

**Issue:** If you see SHA-1 errors, ensure react/react-native are in root node_modules (controlled by workspace `hoistingLimits`).

## Demo Features by Screen

### Home Screen

**🚀 Send Test Logs:**

- Sends console logs and custom events
- Click counter tracked
- User action name: `test_logs_button`

**👤 Set User Info:**

- Demonstrates `faro.api.setUser()`
- All subsequent telemetry associated with user
- User action name: `set_user_button`

**🎯 Manual User Action:**

- Uses `trackUserAction()` API
- Shows manual action tracking
- Counter of tracked actions

**Navigation Buttons:**

- All wrapped with `withFaroUserAction` HOC
- Custom action names per button
- Context includes destination

### Error Demo Screen

Demonstrates error capture:

- Sync errors (throw new Error)
- Async errors (Promise rejection)
- Unhandled rejections
- Console.error capture

### Performance Demo Screen

Demonstrates measurements:

- Heavy computation timing
- Slow render timing
- Custom measurements via `faro.api.pushMeasurement()`

### Tracing Demo Screen

10 comprehensive scenarios:

1. Simple fetch (automatic tracing)
2. Parallel requests
3. Manual span creation
4. Nested spans
5. Span with attributes
6. Span with events
7. Error span
8. User action correlation
9. Long-running operation
10. Distributed trace (requires backend)

### Device Info Screen

Shows collected device metadata:

- Device model, manufacturer, OS
- Memory usage
- Screen dimensions
- Locale, timezone
- Battery level, charging status
- Network carrier

## Testing the Demo

### Verify Telemetry in Grafana Cloud

1. Open Grafana Cloud: `https://<your-org>.grafana.net`
2. Navigate to Explore
3. Select Loki data source
4. Query:

```logql
{app_name="React Native Test"}
```

5. Filter by kind:

- `kind="log"` - Console logs
- `kind="event"` - Custom events
- `kind="measurement"` - Performance metrics
- `kind="exception"` - Errors
- `kind="user_action"` - User interactions

### Verify Sessions

Check session tracking:

```logql
{app_name="React Native Test"} | json | session_id="<session-id>"
```

### Verify User Tracking

After clicking "Set User Info":

```logql
{app_name="React Native Test"} | json | user_id="demo-user-123"
```

### Verify Traces

Navigate to Tempo in Grafana Cloud:

1. Search for traces by service name: `React Native Test`
2. Look for spans with HTTP methods
3. Check span attributes include session ID and user info

## Common Issues

### Metro Won't Start

```bash
# Clear watchman
watchman watch-del-all

# Clear Metro cache
yarn start --reset-cache

# Clear temp files
rm -rf /tmp/metro-* /tmp/haste-*
```

### iOS Build Fails

```bash
# Clean CocoaPods
cd ios
rm -rf Pods Podfile.lock
pod deintegrate
pod install
cd ..

# Clean Xcode build
cd ios
xcodebuild clean
cd ..

# Full rebuild
yarn ios
```

### Android Build Fails

**Current Status:** Android has workspace gradle path resolution issues. The native code is complete but the demo app's gradle configuration needs fixes.

### App Shows Blank Screen

Check Metro bundler console for errors. Common causes:

- TypeScript error in source code
- Missing dependency
- Import path issue

### Changes Not Reflecting

1. Ensure Metro is running
2. Reload the app: `Cmd+R` (iOS) or `R+R` (Android)
3. If still not working, restart Metro: `yarn start --reset-cache`

## Adding New Demo Screens

1. Create screen component in `src/screens/`
2. Add to navigation in `App.tsx`
3. Integrate Faro features:
   - Use `withFaroUserAction` for tracked buttons
   - Call `faro.api.pushEvent()` for custom events
   - Use `faro.api.pushMeasurement()` for metrics
4. Document in README.md

## Code Style

The demo follows the same code style as the SDK packages:

- ESLint + Prettier
- TypeScript strict mode
- Alphabetical import order
- Defensive null checking (no `!` operators)

Run linting:

```bash
yarn lint
```

## Performance Monitoring

The demo app shows live performance metrics:

- CPU usage (native monitoring)
- Memory usage (native monitoring)
- App startup time (native tracking)

**iOS:** Works out of the box
**Android:** Native code ready, waiting for workspace gradle fixes
