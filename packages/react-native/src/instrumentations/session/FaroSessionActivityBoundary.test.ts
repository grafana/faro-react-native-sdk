import React from 'react';
import { Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import * as directSessionActivity from './directSessionActivity';
import { FaroSessionActivityBoundary } from './FaroSessionActivityBoundary';

describe('FaroSessionActivityBoundary', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    if (renderer != null) {
      const mountedRenderer = renderer;
      act(() => mountedRenderer.unmount());
      renderer = undefined;
    }
    jest.restoreAllMocks();
  });

  it('renders a boundary that records a captured touch without claiming the responder', async () => {
    const notifySpy = jest.spyOn(directSessionActivity, 'notifySessionActivity').mockImplementation();
    const child = React.createElement(Text, null, 'Press me');
    const event = { nativeEvent: {} } as never;
    await act(async () => {
      renderer = create(React.createElement(FaroSessionActivityBoundary, null, child));
    });
    if (renderer == null) {
      throw new Error('Expected the activity boundary to render.');
    }

    const boundary = renderer.root.findByType(View);
    const claimsResponder = boundary.props.onStartShouldSetResponderCapture(event);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(claimsResponder).toBe(false);
    expect(renderer.root.findByType(Text).props.children).toBe('Press me');
  });

  it('preserves a caller responder decision and layout override', async () => {
    const onStartShouldSetResponderCapture = jest.fn(() => true);
    const event = { nativeEvent: {} } as never;
    await act(async () => {
      renderer = create(
        React.createElement(FaroSessionActivityBoundary, {
          onStartShouldSetResponderCapture,
          style: { flex: 0, height: 40 },
        })
      );
    });
    if (renderer == null) {
      throw new Error('Expected the activity boundary to render.');
    }

    const boundary = renderer.root.findByType(View);

    expect(boundary.props.onStartShouldSetResponderCapture(event)).toBe(true);
    expect(onStartShouldSetResponderCapture).toHaveBeenCalledWith(event);
    expect(boundary.props.style).toEqual([{ flex: 1 }, { flex: 0, height: 40 }]);
  });
});
