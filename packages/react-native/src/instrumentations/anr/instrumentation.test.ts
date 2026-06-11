import { type ExceptionEvent, initializeFaro, type TransportItem } from '@grafana/faro-core';
import { mockConfig, MockTransport } from '@grafana/faro-test-utils';

import { ANRInstrumentation } from './instrumentation';

describe('ANRInstrumentation', () => {
  it('should report ANRs as fatal exceptions', async () => {
    const transport = new MockTransport();
    const instrumentation = new ANRInstrumentation();
    const nativeModule = {
      getANRStatus: jest.fn(() =>
        Promise.resolve([
          JSON.stringify({
            duration: 5000,
            stacktrace: 'main thread stack',
            timestamp: 1710000000000,
            type: 'ANR',
          }),
        ])
      ),
    };

    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [instrumentation],
      })
    );

    await (
      instrumentation as unknown as {
        checkANRStatus: (nativeModule: typeof nativeModule) => Promise<void>;
      }
    ).checkANRStatus(nativeModule);

    const item = transport.items.find((transportItem) => {
      return (transportItem.payload as { type?: string }).type === 'ANR';
    }) as TransportItem<ExceptionEvent>;

    expect(item.payload.type).toBe('ANR');
    expect(item.payload.fatal).toBe(true);
    expect(item.payload.context?.mechanism).toBe('anr');
    expect(item.payload.context?.stacktrace).toBe('main thread stack');
  });
});
