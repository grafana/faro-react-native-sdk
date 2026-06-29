import {
  enhanceErrorWithContext,
  getPlatformErrorContext,
  getStackFramesFromError,
  parseStackTrace,
  parseStackTraceLine,
  toFaroStackFrames,
} from './stackTraceParser';

describe('Stack Trace Parser', () => {
  describe('parseStackTraceLine', () => {
    it('should parse standard React Native format', () => {
      const line = '  at functionName (file.js:123:45)';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'functionName',
        filename: 'file.js',
        lineno: 123,
        colno: 45,
      });
    });

    it('should parse Metro bundler format', () => {
      const line = '  at Object.functionName (/path/to/file.js:123:456)';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'Object.functionName',
        filename: '/path/to/file.js',
        lineno: 123,
        colno: 456,
      });
    });

    it('should parse anonymous format', () => {
      const line = '  at anonymous (file.js:123:45)';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'anonymous', // 'anonymous' matches the REACT_NATIVE_STACK_REGEX first
        filename: 'file.js',
        lineno: 123,
        colno: 45,
      });
    });

    it('should parse native format', () => {
      const line = '  at nativeFunction (native)';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'nativeFunction',
        filename: '<native>',
        isNative: true,
      });
    });

    it('should parse release/minified format', () => {
      const line = 'a@123:456';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'a',
        filename: '<unknown>',
        lineno: 123,
        colno: 456,
        releaseLine: true,
      });
    });

    it('should normalize Hermes Android "address at index.android.bundle" file segment', () => {
      const line = '  at someFunction (address at index.android.bundle:42:15)';
      const frame = parseStackTraceLine(line);

      expect(frame).toEqual({
        function: 'someFunction',
        filename: 'index.android.bundle',
        lineno: 42,
        colno: 15,
      });
    });

    it('should parse Hermes-style parenthesis frame with bundle filename', () => {
      const line = '  at reportError (index.android.bundle:1:849989)';
      expect(parseStackTraceLine(line)).toEqual({
        function: 'reportError',
        filename: 'index.android.bundle',
        lineno: 1,
        colno: 849989,
      });
    });

    it('should return null for invalid lines', () => {
      expect(parseStackTraceLine('')).toBeNull();
      expect(parseStackTraceLine('   ')).toBeNull();
      expect(parseStackTraceLine('invalid line')).toBeNull();
      expect(parseStackTraceLine(null as any)).toBeNull();
      expect(parseStackTraceLine(undefined as any)).toBeNull();
    });
  });

  describe('parseStackTrace', () => {
    it('should parse multi-line stack traces', () => {
      const stackTrace = `Error: Something went wrong
  at functionA (fileA.js:10:5)
  at functionB (fileB.js:20:10)
  at native (native)`;

      const frames = parseStackTrace(stackTrace);

      expect(frames).toHaveLength(3);
      expect(frames[0]).toEqual({
        function: 'functionA',
        filename: 'fileA.js',
        lineno: 10,
        colno: 5,
      });
      expect(frames[1]).toEqual({
        function: 'functionB',
        filename: 'fileB.js',
        lineno: 20,
        colno: 10,
      });
      expect(frames[2]).toEqual({
        function: 'native',
        filename: '<native>',
        isNative: true,
      });
    });

    it('should handle empty or invalid stack traces', () => {
      expect(parseStackTrace('')).toEqual([]);
      expect(parseStackTrace(null as any)).toEqual([]);
      expect(parseStackTrace(undefined as any)).toEqual([]);
      expect(parseStackTrace('invalid\nstack\ntrace')).toEqual([]);
    });

    it('should skip unparseable lines', () => {
      const stackTrace = `Error: Something went wrong
  at functionA (fileA.js:10:5)
  some unparseable line
  at functionB (fileB.js:20:10)`;

      const frames = parseStackTrace(stackTrace);

      expect(frames).toHaveLength(2);
      expect(frames[0]?.function).toBe('functionA');
      expect(frames[1]?.function).toBe('functionB');
    });
  });

  describe('toFaroStackFrames', () => {
    it('should convert parsed frames to Faro format', () => {
      const parsedFrames = [
        {
          function: 'testFunc',
          filename: 'test.js',
          lineno: 10,
          colno: 5,
        },
        {
          function: undefined,
          filename: undefined,
          lineno: undefined,
          colno: undefined,
        },
      ];

      const faroFrames = toFaroStackFrames(parsedFrames);

      expect(faroFrames).toHaveLength(2);
      expect(faroFrames[0]).toEqual({
        function: 'testFunc',
        filename: 'test.js',
        lineno: 10,
        colno: 5,
      });
      expect(faroFrames[1]).toEqual({
        function: '<anonymous>',
        filename: '<unknown>',
        lineno: undefined,
        colno: undefined,
      });
    });

    it('should handle empty array', () => {
      const faroFrames = toFaroStackFrames([]);
      expect(faroFrames).toEqual([]);
    });

    it('maps release placeholders to bundle.js in Faro frames', () => {
      const parsed = parseStackTraceLine('a@123:456');
      expect(parsed).not.toBeNull();
      const faroFrames = toFaroStackFrames([parsed!]);
      expect(faroFrames[0]?.filename).toBe('bundle.js');
    });

    it('maps release placeholders to a custom bundle filename', () => {
      const parsed = parseStackTraceLine('a@123:456');
      expect(parsed).not.toBeNull();
      const faroFrames = toFaroStackFrames([parsed!], { releaseBundleFilename: 'index.android.bundle' });
      expect(faroFrames[0]?.filename).toBe('index.android.bundle');
    });

    it('collapses Hermes absolute .app bundle path to basename so uploads match ingest keys', () => {
      const iosPath =
        '/Users/ci/Library/Developer/CoreSimulator/Devices/ABC/Data/Containers/Bundle/Application/62A2/MyApp.app/main.jsbundle';
      const parsed = parseStackTraceLine(`  at reportHandledException (${iosPath}:1:1249030)`);
      expect(parsed).not.toBeNull();
      const faroFrames = toFaroStackFrames([parsed!], { releaseBundleFilename: 'main.jsbundle' });
      expect(faroFrames[0]?.filename).toBe('main.jsbundle');
      expect(faroFrames[0]?.lineno).toBe(1);
      expect(faroFrames[0]?.colno).toBe(1249030);
    });

    it('collapses absolute Android artifact path ending in index.android.bundle', () => {
      const apkPath = '/data/app/org.example.cp/base.apk/assets/index.android.bundle';
      const parsed = parseStackTraceLine(`  at reportError (${apkPath}:1:849989)`);
      expect(parsed).not.toBeNull();
      const faroFrames = toFaroStackFrames([parsed!], { releaseBundleFilename: 'index.android.bundle' });
      expect(faroFrames[0]?.filename).toBe('index.android.bundle');
    });
  });

  describe('getStackFramesFromError', () => {
    it('should extract stack frames from Error object', () => {
      const error = new Error('Test error');
      error.stack = `Error: Test error
  at testFunction (test.js:10:5)
  at anotherFunction (another.js:20:10)`;

      const frames = getStackFramesFromError(error);

      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toHaveProperty('function');
      expect(frames[0]).toHaveProperty('filename');
    });

    it('should return empty array for error without stack', () => {
      const error = new Error('Test error');
      error.stack = undefined;

      const frames = getStackFramesFromError(error);
      expect(frames).toEqual([]);
    });

    it('should return empty array for null/undefined error', () => {
      expect(getStackFramesFromError(null as any)).toEqual([]);
      expect(getStackFramesFromError(undefined as any)).toEqual([]);
    });

    it('should handle parsing failures gracefully', () => {
      const error = new Error('Test error');
      error.stack = 'completely invalid stack trace format';

      const frames = getStackFramesFromError(error);
      expect(Array.isArray(frames)).toBe(true);
    });
  });

  describe('getPlatformErrorContext', () => {
    it('should return platform context', () => {
      const context = getPlatformErrorContext();

      expect(context).toHaveProperty('platform');
      expect(context).toHaveProperty('platformVersion');
      expect(context).toHaveProperty('isHermes');
      expect(typeof context.platform).toBe('string');
      expect(typeof context.platformVersion).toBe('string');
    });
  });

  describe('enhanceErrorWithContext', () => {
    it('should enhance error with stack frames and context', () => {
      const error = new Error('Test error');
      error.stack = `Error: Test error
  at testFunction (test.js:10:5)`;

      const result = enhanceErrorWithContext(error);

      expect(result.error).toBe(error);
      expect(Array.isArray(result.stackFrames)).toBe(true);
      expect(result.context).toHaveProperty('platform');
      expect(result.context).toHaveProperty('platformVersion');
      expect(result.context).toHaveProperty('isHermes');
    });

    it('should merge additional context', () => {
      const error = new Error('Test error');
      const additionalContext = {
        isFatal: 'true',
        customField: 'customValue',
      };

      const result = enhanceErrorWithContext(error, additionalContext);

      expect(result.context).toHaveProperty('isFatal', 'true');
      expect(result.context).toHaveProperty('customField', 'customValue');
      expect(result.context).toHaveProperty('platform');
    });

    it('applies stack parse options for release frames', () => {
      const error = new Error('Test');
      error.stack = 'global@10:20';

      const result = enhanceErrorWithContext(error, undefined, { releaseBundleFilename: 'main.jsbundle' });

      expect(result.stackFrames[0]?.filename).toBe('main.jsbundle');
    });
  });
});
