import { type PropsWithChildren } from 'react';
import { type GestureResponderEvent, StyleSheet, View, type ViewProps } from 'react-native';

import { notifySessionActivity } from './directSessionActivity';

export type FaroSessionActivityBoundaryProps = PropsWithChildren<ViewProps>;

/**
 * Records touch activity for the React Native subtree without emitting a user
 * action or taking ownership of the responder.
 */
export function FaroSessionActivityBoundary({
  children,
  onStartShouldSetResponderCapture,
  style,
  ...viewProps
}: FaroSessionActivityBoundaryProps) {
  const handleStartShouldSetResponderCapture = (event: GestureResponderEvent): boolean => {
    notifySessionActivity();
    return onStartShouldSetResponderCapture?.(event) ?? false;
  };

  return (
    <View
      {...viewProps}
      onStartShouldSetResponderCapture={handleStartShouldSetResponderCapture}
      style={[styles.container, style]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
