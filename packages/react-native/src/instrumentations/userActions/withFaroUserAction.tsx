import React, { type ComponentType } from 'react';
import type { GestureResponderEvent } from 'react-native';

import { faro, type UserActionInternalInterface } from '@grafana/faro-core';

export interface WithFaroUserActionProps {
  /**
   * Optional: Override the action name for this specific instance
   */
  faroActionName?: string;

  /**
   * Optional: Additional context to attach to the user action
   */
  faroContext?: Record<string, string>;

  /**
   * The original onPress handler
   */
  onPress?: (event: GestureResponderEvent) => void;
}

/**
 * Higher-Order Component that wraps React Native touchable components
 * to automatically track user interactions.
 *
 * @param Component - The component to wrap (e.g., TouchableOpacity, Button, etc.)
 * @param defaultActionName - The default name for this action
 *
 * @example
 * ```tsx
 * import { TouchableOpacity } from 'react-native';
 * import { withFaroUserAction } from '@grafana/faro-react-native';
 *
 * const TrackedButton = withFaroUserAction(TouchableOpacity, 'submit_form');
 *
 * function MyForm() {
 *   return (
 *     <TrackedButton onPress={handleSubmit}>
 *       <Text>Submit</Text>
 *     </TrackedButton>
 *   );
 * }
 * ```
 */
export function withFaroUserAction<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  defaultActionName: string
): ComponentType<P & WithFaroUserActionProps> {
  return function FaroTrackedComponent(props: P & WithFaroUserActionProps) {
    const { faroActionName, faroContext, onPress, ...restProps } = props;

    const handlePress = (event: GestureResponderEvent) => {
      try {
        // Use the prop-specific name or fall back to the default
        const actionName = faroActionName || defaultActionName;

        // End any active user action before starting a new one to avoid "already running" errors
        // (e.g. when user taps another button before the previous action's HTTP request completes)
        // getActiveUserAction returns UserActionInterface but the runtime object is the full
        // UserAction implementing UserActionInternalInterface (with end)
        const activeAction = faro?.api?.getActiveUserAction?.() as
          | UserActionInternalInterface
          | undefined;
        activeAction?.end();

        // Start a user action - UserActionInstrumentation subscribes to the message bus
        // and attaches UserActionController for auto-ending and HTTP correlation
        faro?.api?.startUserAction?.(actionName, faroContext || {}, { triggerName: 'press' });
      } catch (error) {
        // Don't let tracking errors break the app
        console.warn('[Faro] Error tracking user action:', error);
      }

      // Always call the original onPress handler
      onPress?.(event);
    };

    return React.createElement(Component, {
      ...(restProps as P),
      onPress: handlePress,
    });
  };
}

/**
 * Manually track a user action without using the HOC
 *
 * @param actionName - The name of the action
 * @param context - Optional context to attach
 *
 * @example
 * ```tsx
 * import { trackUserAction } from '@grafana/faro-react-native';
 *
 * function handleComplexAction() {
 *   const action = trackUserAction('complex_workflow', { step: '1' });
 *
 *   // Do work...
 *   doSomething();
 *
 *   // End the action when done
 *   action?.end();
 * }
 * ```
 */
export function trackUserAction(actionName: string, context?: Record<string, string>) {
  try {
    // End any active user action before starting a new one
    const activeAction = faro?.api?.getActiveUserAction?.() as
      | UserActionInternalInterface
      | undefined;
    activeAction?.end();
    return faro?.api?.startUserAction?.(actionName, context || {}, { triggerName: 'manual' });
  } catch (error) {
    console.warn('[Faro] Error tracking user action:', error);
    return undefined;
  }
}
