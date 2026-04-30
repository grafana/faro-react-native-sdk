# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the Grafana Faro React Native SDK - a monorepo containing packages for real user monitoring (RUM) in React Native applications. The codebase was migrated from the faro-web-sdk repository with full git history preserved.

**Key Packages:**

- `@grafana/faro-react-native` - Core SDK with instrumentations, metas, and transports
- `@grafana/faro-react-native-tracing` - OpenTelemetry distributed tracing integration
- `@grafana/faro-test-utils` - Internal test utilities (not published)
- `demo/` - Full-featured demo application (not published)

**Critical Dependencies:**

- `@grafana/faro-core@^2.2.3` - Using caret versioning for minor/patch updates.
- React Native 0.82.1+
- Yarn Berry 4.12.0

## Build System & Commands

### Essential Commands

```bash
# Install dependencies (from root)
yarn install

# Build all packages
yarn build

# Run all tests
yarn quality:test

# Run tests for a single package
cd packages/react-native && yarn quality:test

# Run specific test file
cd packages/react-native && npx jest src/path/to/file.test.ts

# Run specific test case
cd packages/react-native && npx jest -t "test name pattern"

# Lint everything
yarn quality:lint

# Format everything
yarn quality:format

# Check for circular dependencies
yarn quality:circular-deps
```

### Demo App Commands

Commands to run from root folder:

```bash
# Start Metro bundler
yarn start:demo

# Run on iOS (from root)
yarn ios

# Run on Android (from root)
yarn android

```

### iOS Native Module Setup

```bash
cd demo/ios
pod install
cd ../..
yarn ios
```

## Architecture

### Monorepo Structure

This is a Lerna + Yarn Workspaces monorepo with critical hoisting configuration:

```json
"installConfig": {
  "hoistingLimits": "workspaces"
}
```

**Why this matters:** React and React Native MUST be hoisted to root `node_modules` to prevent Metro bundler issues. The `hoistingLimits: "workspaces"` setting ensures workspace dependencies stay within their packages while allowing shared deps to hoist.

### Package Build System

Each package builds to multiple formats:

- **CommonJS**: `dist/cjs/` - Node.js compatibility
- **ESM**: `dist/esm/` - Modern bundlers
- **TypeScript**: `dist/types/` - Type definitions

**Build Process:**

1. TypeScript compiles with separate configs: `tsconfig.cjs.json` and `tsconfig.esm.json`
2. Both extend from `tsconfig.base.{cjs,esm}.json` at root
3. Demo app uses source files directly via `react-native` field in package.json for fast development

### Instrumentation Architecture

All instrumentations extend `BaseInstrumentation` from `@grafana/faro-core`. The lifecycle is:

1. **Registration**: Added to config via `getRNInstrumentations()` or manually
2. **Initialization**: `initialize()` called by Faro core during `initializeFaro()`
3. **Runtime**: Instrumentations patch globals, register listeners, collect telemetry
4. **Cleanup**: `unpatch()` called on shutdown (if implemented)

**Key Pattern - Global Patching:**
Many instrumentations patch global objects (console, fetch, ErrorUtils). Always:

- Store original reference before patching
- Restore original in `unpatch()`
- Handle missing globals gracefully (not all RN versions have everything)

**Key Pattern - Avoiding Infinite Loops:**
Console/Error instrumentations must NOT use console.log or trigger errors internally. Use `this.logDebug()` / `this.logInfo()` from BaseInstrumentation which uses faro-core's internal logger.

### Transport System

The SDK uses a batched transport system:

- `FetchTransport` - Sends telemetry to Grafana Cloud collector
- `ConsoleTransport` - Logs telemetry to console for debugging
- Both implement circuit breaker pattern to handle offline scenarios

**Critical:** Transports must NOT be traced by HttpInstrumentation or TracingInstrumentation. Collector URLs are automatically filtered to prevent infinite loops.

### Testing Strategy

**Test Environment Configuration:**

- Base config: `jest.config.base.js` with shared moduleNameMapper
- Per-package: Each package has own `jest.config.js` that extends base
- Test utils: `@grafana/faro-test-utils` package provides mocks

**Critical Test Patterns:**

1. **Mock React Native APIs:**

```typescript
(AppState as any).addEventListener = jest.fn((event, handler) => ({
  remove: jest.fn(),
}));
```

2. **Use fake timers for time-based tests:**

```typescript
jest.useFakeTimers();
// ... test code
jest.runAllTimers();
jest.useRealTimers();
```

3. **Clean up between tests:**

```typescript
beforeEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});
```

## Code Practices

### Defensive Null Checking

**DO NOT use non-null assertions (`!`)** - Use defensive null checking instead:

```typescript
// ❌ Bad
const value = match[2]!;

// ✅ Good
if (match && match[2]) {
  const value = match[2];
}
```

### Import Order

ESLint enforces alphabetical import order with group separation:

1. Built-in + external packages
2. `@grafana/*` packages (internal group)
3. Parent imports
4. Sibling imports

**Auto-fix:** `yarn quality:format` will fix import order.

### TypeScript Configuration

- Strict mode enabled across all packages
- No implicit any
- Strict null checks
- All packages must build without errors before committing

### React Native Compatibility

When adding new features:

1. Check React Native version compatibility (target: 0.70+)
2. Test on both iOS and Android if touching native code
3. Handle platform differences explicitly (use `Platform.OS`)
4. Gracefully degrade on older RN versions

### Native Module Integration

Native modules (like StartupInstrumentation) must:

- Support autolinking via `react-native.config.js`
- Provide synchronous methods for critical operations
- Handle missing native module gracefully in JS
- Include TypeScript definitions via codegen spec

**iOS-specific:**

- Force Old Architecture mode in podspec: `RCT_NEW_ARCH_ENABLED = 0`
- Use `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` for sync methods
- Clean build folder when encountering "not found" errors

**Android-specific (Current Status):**

- Android implementation complete but has Yarn workspace path resolution issues
- Works fine in standalone projects
- Issue is specific to demo app's gradle configuration with workspaces

## Testing Patterns

### Running Tests During Development

```bash
# Watch mode for specific package
cd packages/react-native
yarn quality:test --watch

# Run single test file
npx jest src/instrumentations/errors/instrumentation.test.ts

# Run tests matching pattern
npx jest --testNamePattern="should capture errors"

# Debug test with node inspector
node --inspect-brk node_modules/.bin/jest --runInBand
```

### Common Test Scenarios

**Testing Instrumentations:**

1. Mock global APIs the instrumentation patches
2. Initialize Faro with the instrumentation
3. Trigger the behavior (call API, change app state, etc.)
4. Assert telemetry was sent to mock transport
5. Clean up in afterEach

**Testing React Components:**

1. Mock Faro API if component uses it
2. Render component
3. Trigger interactions
4. Assert Faro API calls
5. Clean up

**Testing Async Operations:**

1. Use `jest.useFakeTimers()` for setTimeout/setInterval tests
2. Always call `jest.useRealTimers()` in cleanup
3. Use `await` for promises before assertions
4. Use `jest.runAllTimers()` to flush timer queue

## Common Issues & Solutions

### Metro Bundler SHA-1 Errors

If you see "Metro couldn't find SHA-1 for react-native/index.js":

- Ensure react/react-native are in root node_modules (check hoisting)
- Clear Metro cache: `yarn start:demo --reset-cache`
- Verify metro.config.js resolveRequest handles both demo and root paths

### TypeScript Compilation Errors After Dependency Changes

1. Clear build artifacts: `yarn clean`
2. Rebuild: `yarn build`
3. If still failing, check @grafana/faro-core version matches expectations (should be 2.0.2)

### Test Failures Due to Timer Interference

Always wrap tests using real timeouts in jest.useFakeTimers():

```typescript
it('test with timeout', () => {
  jest.useFakeTimers();
  // test code
  jest.runAllTimers();
  jest.useRealTimers();
});
```

### Native Module "Not Available" Errors

**iOS:**

```bash
cd demo/ios
rm -rf Pods Podfile.lock
pod install
cd ../..
yarn ios
```

**Android:**
Currently affected by workspace gradle issues. Native code is complete and ready.

## Git Workflow

### Commit Messages

Follow conventional commit format:

- `feat: add new feature`
- `fix: resolve bug`
- `docs: update documentation`
- `test: add tests`
- `chore: update dependencies`

### Pre-commit Hooks

Husky + lint-staged runs automatically:

- Lints staged files
- Formats staged files
- Runs affected tests (if configured)

**To skip (emergency only):** `git commit --no-verify`

### Pre-PR Checklist

Run these checks locally before opening a pull request to avoid CI failures:

```bash
# Lint and format all packages (catches Prettier + ESLint issues)
yarn quality:lint

# Run the full test suite
yarn quality:test

# Ensure packages compile cleanly
yarn build
```

### Creating Commits

**NEVER include Co-Authored-By: Claude Sonnet 4.5** in commits unless explicitly requested by the user. This was a temporary requirement during migration.

## Package Publishing

Managed via Lerna:

```bash
# Version packages (prompts for version bump, commit, tags). Push to GitHub to trigger the release workflow.
yarn bump:version
```

**Pre-publish checklist:**

1. All tests pass: `yarn quality:test`
2. Builds succeed: `yarn build`
3. No circular dependencies: `yarn quality:circular-deps`
4. CHANGELOG.md updated
5. README.md reflects changes

## Key Files Reference

- `jest.config.base.js` - Shared Jest configuration with module resolution
- `eslint.config.mjs` - ESLint flat config with TypeScript + React rules
- `tsconfig.base.json` - Base TypeScript configuration
- `lerna.json` - Lerna configuration for monorepo management
- `packages/react-native/src/index.ts` - Main export file (check here for public API)
- `packages/react-native/src/config/getRNInstrumentations.ts` - Default instrumentation setup

## Documentation

### docs/mobile-rum/

The Mobile RUM comparison docs (`docs/mobile-rum/index.md` and related files) are read by both technical and non-technical people (product, support, stakeholders). When writing or updating it:

- **Audience**: Assume readers include people unfamiliar with implementation details.
- **"How Data is Collected"**: Keep the list structure (bullets, iOS/Android breakdown) but use plain language. Avoid file paths, class names, internal APIs. It's fine to name libraries (e.g. axios, dio) when relevant.
- **Prefer**: "The SDK automatically tracks..." over "Patches `global.fetch` via `HttpInstrumentation`".
- **Avoid**: `task_threads()`, `phys_footprint`, `/proc/[pid]/stat`, `markEventEnd`, `startSpanManual`, etc., unless the technical distinction matters for the comparison.
- **Flutter SDK values**: Never use "Check Flutter docs" as a placeholder. If `faro-flutter-sdk` is in the workspace, go to `faro-flutter-sdk/lib/` and look up the implementation (config option, event name, default value, etc.)—do not search the web. Only search the web if `faro-flutter-sdk` is not cloned in the workspace.

## Feature Parity Notes

This SDK aims for feature parity with:

1. Faro Web SDK (where applicable to React Native)
2. Faro Flutter SDK (for mobile-specific features like startup tracking, performance monitoring)

When implementing new features, check:

- `docs/mobile-rum/feature-parity-matrix.md` - Detailed feature comparison between React Native and Flutter SDKs
- Faro Flutter SDK: If `faro-flutter-sdk` is in the workspace, go to `faro-flutter-sdk/lib/` and inspect for implementation details and patterns. Only search the web if the repo is not in the workspace.

## Performance Monitoring

Native OS-level APIs are used for accurate metrics:

- **iOS:** `host_statistics()` for CPU, `task_info()` for memory
- **Android:** `/proc/[pid]/stat` for CPU, `/proc/[pid]/status` for memory

These implementations match the Flutter SDK for cross-platform consistency.
