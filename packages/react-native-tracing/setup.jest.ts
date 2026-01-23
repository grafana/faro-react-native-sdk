import { TextDecoder, TextEncoder } from 'util';

// Polyfill TextEncoder/TextDecoder for OTEL
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test setup requires global polyfills
(global as any).TextEncoder = TextEncoder;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test setup requires global polyfills
(global as any).TextDecoder = TextDecoder;

// Mock Request and Response for fetch instrumentation tests
class MockRequest {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}

class MockResponse {
  ok: boolean = true;
  status: number = 200;
  statusText: string = 'OK';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test setup requires global polyfills
(global as any).Request = MockRequest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test setup requires global polyfills
(global as any).Response = MockResponse;
