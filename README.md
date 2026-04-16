# Grafana Faro React Native SDK

Official React Native implementation of Grafana Faro - real user monitoring SDK
for React Native applications.

## Overview

The Faro React Native SDK brings comprehensive observability to React Native
applications, enabling you to collect logs, traces, and errors from your mobile
applications. This SDK provides deep integration with React Native's ecosystem and
includes native code support for both iOS and Android platforms.

## Packages

This monorepo contains the following packages:

- **[@grafana/faro-react-native](./packages/react-native)**: Core SDK with
  instrumentations, metas, and transports
  - Error tracking with stack traces
  - Performance monitoring (CPU, memory)
  - Console logging instrumentation
  - HTTP request tracking
  - Session management
  - Navigation tracking (React Navigation support)
  - Native code integration (iOS Swift, Android Kotlin)

- **[@grafana/faro-react-native-tracing](./packages/react-native-tracing)**:
  OpenTelemetry distributed tracing integration
  - Automatic trace propagation
  - Custom instrumentation support
  - OTLP export to Faro backend

- **[demo](./demo)**: Full-featured React Native demo application
  - Comprehensive examples of SDK features
  - Performance testing utilities
  - Error boundary demonstrations
  - Tracing examples

## Quick Start

### Installation

```bash
# Install core package
npm install @grafana/faro-react-native

# Optional: Install tracing package
npm install @grafana/faro-react-native-tracing
```

### Basic Usage

```typescript
import { initializeFaro, LogLevel } from '@grafana/faro-react-native';

// Initialize Faro
const faro = initializeFaro({
  url: 'https://your-faro-endpoint.com/collect',
  app: {
    name: 'my-react-native-app',
    version: '1.0.0',
  },
});

// Send logs with different severity levels
faro.api.pushLog(['Application started']); // defaults to LogLevel.LOG
faro.api.pushLog(['User signed in'], { level: LogLevel.INFO });
```

For detailed usage instructions, see the [core package README](./packages/react-native/README.md).

## Development

### Prerequisites

- Node.js (LTS version)
- Yarn 4.12.0 (included via Yarn Berry)
- React Native development environment (Xcode for iOS, Android Studio for Android)

### Setup

```bash
# Clone the repository
git clone https://github.com/grafana/faro-react-native-sdk.git
cd faro-react-native-sdk

# Install dependencies
yarn install

# Build all packages
yarn build
```

### Running the Demo

```bash
# Start Metro bundler
yarn start:demo

# Run on iOS
yarn ios

# Run on Android
yarn android
```

### Testing

```bash
# Run all tests
yarn quality:test

# Run linting
yarn quality:lint

# Check circular dependencies
yarn quality:circular-deps
```

## Architecture

The SDK is built as a monorepo using:

- **Yarn Workspaces**: For dependency management
- **Lerna**: For versioning and publishing
- **TypeScript**: For type safety and development experience
- **Jest**: For unit testing

Each package builds to multiple formats:

- CommonJS (for Node.js compatibility)
- ESM (for modern bundlers)
- TypeScript definitions

## Documentation

- [Core SDK Documentation](./packages/react-native/README.md)
- [Tracing Documentation](./packages/react-native-tracing/README.md)
- [Feature Parity Matrix](./docs/mobile-rum/feature-parity-matrix.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

## Contributing

We welcome contributions! Please see our
[Contributing Guide](./CONTRIBUTING.md) for details on:

- Development workflow
- Code style and conventions
- Testing requirements
- Pull request process

## License

This project is licensed under the Apache License 2.0 - see the
[LICENSE](LICENSE) file for details.

## Support

<!-- markdownlint-disable-next-line MD013 -->

- Documentation: [Grafana Faro Documentation](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/)
- GitHub Issues: [Report bugs or request features](https://github.com/grafana/faro-react-native-sdk/issues)
- Grafana Community: [Join the discussion](https://community.grafana.com/)

## Related Projects

- [Grafana Faro Web SDK](https://github.com/grafana/faro-web-sdk) - Web browser implementation
- [Grafana Faro](https://github.com/grafana/faro) - Backend collector service
