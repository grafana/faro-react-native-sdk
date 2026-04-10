import { mockConfig, MockTransport } from '@grafana/faro-test-utils';
import { initializeFaro } from '../../initialize';
import { SessionInstrumentation } from './index';

describe('SessionInstrumentation beforeSend hook', () => {
  let transport: MockTransport;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should pass through items when session is sampled (isSampled="true")', () => {
    transport = new MockTransport();
    
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    // Manually set session with isSampled='true'
    const faro = (global as any).faro;
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { isSampled: 'true' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the item (after removing isSampled attribute)
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0].meta.session?.id).toBe('test-session-id');
    expect(transport.items[0].meta.session?.attributes?.['isSampled']).toBeUndefined();
  });

  it('should drop items when session is not sampled (isSampled="false")', () => {
    transport = new MockTransport();
    
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    // Manually set session with isSampled='false'
    const faro = (global as any).faro;
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { isSampled: 'false' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should NOT send the item
    expect(transport.items).toHaveLength(0);
  });

  it('should pass through items when no isSampled attribute exists', () => {
    transport = new MockTransport();
    
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    // Manually set session WITHOUT isSampled attribute
    const faro = (global as any).faro;
    faro.api.setSession({
      id: 'test-session-id',
      attributes: { customAttr: 'value' },
    });

    // Push an event
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the item unchanged
    expect(transport.items).toHaveLength(1);
    expect(transport.items[0].meta.session?.id).toBe('test-session-id');
    expect(transport.items[0].meta.session?.attributes?.['customAttr']).toBe('value');
  });

  it('should pass through items when no session exists', () => {
    transport = new MockTransport();
    
    initializeFaro(
      mockConfig({
        transports: [transport],
        instrumentations: [new SessionInstrumentation()],
        sessionTracking: {
          enabled: true,
          persistent: false,
        },
      })
    );

    const faro = (global as any).faro;

    // Push an event without setting any session
    faro.api.pushEvent('test_event', { data: 'test' });

    // Should send the item
    expect(transport.items).toHaveLength(1);
  });
});
