import React, { type ComponentType, type FC } from 'react';

import { unknownString } from '@grafana/faro-core';

import { FaroErrorBoundary } from './FaroErrorBoundary';
import type { FaroErrorBoundaryProps } from './types';

/**
 * Higher-Order Component that wraps a component with FaroErrorBoundary
 *
 * @example
 * ```tsx
 * import { withFaroErrorBoundary } from '@grafana/faro-react-native';
 * import { Text } from 'react-native';
 *
 * const MyComponent = () => <Text>Hello</Text>;
 *
 * export default withFaroErrorBoundary(MyComponent, {
 *   fallback: <Text>Error occurred</Text>
 * });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic HOC must accept any component props
export function withFaroErrorBoundary<P extends Record<string, any> = {}>(
  WrappedComponent: ComponentType<P>,
  errorBoundaryProps: FaroErrorBoundaryProps
): FC<P> {
  const componentDisplayName = WrappedComponent.displayName ?? WrappedComponent.name ?? unknownString;

  const Component: FC<P> = (wrappedComponentProps: P) =>
    React.createElement(
      FaroErrorBoundary,
      errorBoundaryProps,
      React.createElement(WrappedComponent, wrappedComponentProps)
    );

  Component.displayName = `faroErrorBoundary(${componentDisplayName})`;

  return Component;
}
