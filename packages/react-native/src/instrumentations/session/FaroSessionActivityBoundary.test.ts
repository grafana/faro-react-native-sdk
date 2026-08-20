import React from 'react';
import { Text } from 'react-native';

import * as directSessionActivity from './directSessionActivity';
import { FaroSessionActivityBoundary } from './FaroSessionActivityBoundary';

describe('FaroSessionActivityBoundary', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('records a captured touch without claiming the responder', () => {
    const notifySpy = jest.spyOn(directSessionActivity, 'notifySessionActivity').mockImplementation();
    const child = React.createElement(Text, null, 'Press me');
    const element = FaroSessionActivityBoundary({ children: child });
    const event = { nativeEvent: {} } as never;

    const claimsResponder = element.props.onStartShouldSetResponderCapture(event);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(claimsResponder).toBe(false);
    expect(element.props.children).toBe(child);
  });

  it('preserves a caller responder decision', () => {
    const onStartShouldSetResponderCapture = jest.fn(() => true);
    const element = FaroSessionActivityBoundary({ children: null, onStartShouldSetResponderCapture });
    const event = { nativeEvent: {} } as never;

    expect(element.props.onStartShouldSetResponderCapture(event)).toBe(true);
    expect(onStartShouldSetResponderCapture).toHaveBeenCalledWith(event);
  });
});
