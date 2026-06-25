import { looksLikeNativeTombstoneTrace } from './nativeTombstoneTrace';

describe('looksLikeNativeTombstoneTrace', () => {
  it('detects Android tombstone backtrace lines', () => {
    const trace = [
      "*** *** *** *** *** *** ***",
      "ABI: 'arm64'",
      'backtrace:',
      '      #00 pc 0000000000001234  /data/app/lib/arm64-v8a/libappmodules.so (nativeCrash+8)',
    ].join('\n');

    expect(looksLikeNativeTombstoneTrace(trace)).toBe(true);
  });

  it('returns false for Java stack traces', () => {
    const trace = ['java.lang.RuntimeException: boom', '  at com.example.Foo.bar(Foo.kt:12)'].join('\n');
    expect(looksLikeNativeTombstoneTrace(trace)).toBe(false);
  });
});
