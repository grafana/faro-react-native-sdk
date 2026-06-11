import { parseIosCrashTrace } from './parseIosCrashTrace';

describe('parseIosCrashTrace', () => {
  it('parses iOS PLCrashReporter stack trace format', () => {
    const trace = [
      '0  libsystem_kernel.dylib  0x00000001a2b3c000',
      '1  MyApp  0x0000000100abc123',
      '2  UIKitCore  0x00000001b4567890',
      '3  Foundation  0x00000001a8901234',
    ].join('\n');

    const parsed = parseIosCrashTrace(trace);

    expect(parsed).toEqual({
      frames: [
        {
          module: 'libsystem_kernel.dylib',
          function: '0x00000001a2b3c000',
          filename: 'libsystem_kernel.dylib',
          lineno: 0,
          instructionPointer: '0x00000001a2b3c000',
        },
        {
          module: 'MyApp',
          function: '0x0000000100abc123',
          filename: 'MyApp',
          lineno: 1,
          instructionPointer: '0x0000000100abc123',
        },
        {
          module: 'UIKitCore',
          function: '0x00000001b4567890',
          filename: 'UIKitCore',
          lineno: 2,
          instructionPointer: '0x00000001b4567890',
        },
        {
          module: 'Foundation',
          function: '0x00000001a8901234',
          filename: 'Foundation',
          lineno: 3,
          instructionPointer: '0x00000001a8901234',
        },
      ],
    });
  });

  it('returns null for empty input', () => {
    expect(parseIosCrashTrace('')).toBeNull();
    expect(parseIosCrashTrace('   ')).toBeNull();
  });

  it('handles stack traces with whitespace variations', () => {
    const trace = ['  0   libsystem_kernel.dylib   0x00000001a2b3c000  ', '1  MyApp  0x0000000100abc123'].join('\n');

    const parsed = parseIosCrashTrace(trace);

    expect(parsed?.frames).toHaveLength(2);
    expect(parsed?.frames[0]).toMatchObject({
      module: 'libsystem_kernel.dylib',
      instructionPointer: '0x00000001a2b3c000',
      lineno: 0,
    });
  });

  it('returns null when no valid frames are found', () => {
    const trace = ['Not a valid frame', 'Another invalid line', 'Signal: SIGSEGV'].join('\n');

    expect(parseIosCrashTrace(trace)).toBeNull();
  });

  it('handles mixed valid and invalid lines', () => {
    const trace = [
      'Exception: NSInternalInconsistencyException',
      '0  MyApp  0x0000000100abc123',
      'Some metadata line',
      '1  UIKitCore  0x00000001b4567890',
    ].join('\n');

    const parsed = parseIosCrashTrace(trace);

    expect(parsed?.frames).toHaveLength(2);
    expect(parsed?.frames[0].module).toBe('MyApp');
    expect(parsed?.frames[1].module).toBe('UIKitCore');
  });
});
