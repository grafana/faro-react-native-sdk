# Contributing to Grafana Faro React Native SDK

Thank you for your interest in contributing to the Grafana Faro React Native SDK!
This guide will help you get started with contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

## Code of Conduct

This project follows the [Grafana Labs Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Set up the development environment
4. Create a branch for your changes
5. Make your changes
6. Submit a pull request

## Development Setup

### Prerequisites

- Node.js (LTS version recommended)
- Yarn 4.12.0 (included via Yarn Berry)
- For iOS development: macOS and iOS with Xcode installed
- For Android development: Android Studio and SDK installed

### Initial Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/faro-react-native-sdk.git
cd faro-react-native-sdk

# Add upstream remote
git remote add upstream https://github.com/grafana/faro-react-native-sdk.git

# Install dependencies
yarn install

# Build all packages
yarn build
```

### Working with the Demo App

The demo application is useful for testing your changes:

```bash
# Install demo dependencies
cd demo
yarn install

# For iOS: Install pods
cd ios && pod install && cd ..

# Run on iOS
yarn ios

# Run on Android
yarn android
```

## Making Changes

### Workflow

1. Create a new branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes in the appropriate package:
   - `packages/react-native/` - Core SDK
   - `packages/react-native-tracing/` - Tracing implementation
   - `demo/` - Demo application

3. Write tests for your changes

4. Ensure all tests pass:

   ```bash
   yarn quality:test
   ```

5. Run linting:

   ```bash
   yarn quality:lint
   ```

6. Commit your changes with a descriptive message

### Commit Message Guidelines

Follow conventional commit format:

```text
type(scope): subject

body (optional)

footer (optional)
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:

```text
feat(react-native): add support for custom error handlers

fix(tracing): resolve span export timing issue

docs: update installation instructions
```

## Testing

### Running Tests

```bash
# Run all tests
yarn quality:test

# Run tests for a specific package
cd packages/react-native
yarn quality:test

# Run tests in watch mode
yarn quality:test --watch
```

### Writing Tests

- Write unit tests for all new functionality
- Place test files next to the code they test with `.test.ts` or `.test.tsx` extension
- Use descriptive test names that explain what is being tested
- Follow the existing test patterns in the codebase

### Test Coverage

We strive for high test coverage. Ensure your changes maintain or improve coverage:

```bash
yarn quality:test --coverage
```

## Code Style

### TypeScript

- Use TypeScript for all new code
- Avoid `any` types when possible
- Define proper interfaces and types
- Use meaningful variable and function names

### Formatting

The project uses Prettier and ESLint for code formatting and linting:

```bash
# Format code
yarn quality:format

# Check formatting
yarn quality:lint:prettier

# Lint code
yarn quality:lint:eslint

# Fix linting issues
yarn quality:lint:eslint --fix
```

### Additional Guidelines

- Keep functions small and focused
- Add comments for complex logic
- Use descriptive variable names
- Follow React Native best practices
- Avoid introducing circular dependencies:

  ```bash
  yarn quality:circular-deps
  ```

## Pull Request Process

1. Update your branch with the latest upstream changes:

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. Ensure all tests pass and code is properly formatted

3. Push your changes to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

4. Create a pull request on GitHub:
   - Use a clear, descriptive title
   - Reference any related issues
   - Describe your changes and why they're needed
   - Include screenshots for UI changes
   - List any breaking changes

5. Wait for review:
   - Address any feedback from reviewers
   - Keep the PR updated with main branch
   - Be patient and responsive

6. Once approved, a maintainer will merge your PR

### PR Checklist

- [ ] Code follows the project's style guidelines
- [ ] Tests added/updated and passing
- [ ] Documentation updated (if needed)
- [ ] No circular dependencies introduced
- [ ] Commit messages follow guidelines
- [ ] PR description is clear and complete

## Release Process

Releases are managed by project maintainers using Lerna:

1. Version bumping:

   ```bash
   yarn bump:version
   ```

2. Lerna will:
   - Update package versions
   - Create git tags
   - Update CHANGELOG.md
   - Commit changes

3. GitHub Actions will:
   - Run CI tests
   - Build packages
   - Publish to npm (with provenance)

### Version Strategy

- **Major** (1.0.0): Breaking changes
- **Minor** (0.1.0): New features, backwards compatible
- **Patch** (0.0.1): Bug fixes, backwards compatible

## Need Help?

- Check existing [issues](https://github.com/grafana/faro-react-native-sdk/issues)
- Ask questions in [Grafana Community](https://community.grafana.com/)
- Review the [documentation](./README.md)

## License

By contributing, you agree that your contributions will be licensed under the Apache
License 2.0.
