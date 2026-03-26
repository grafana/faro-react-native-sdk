import { type SamplingContext, SamplingFunction, SamplingRate } from './sampling';

const emptyContext: SamplingContext = { meta: {} };

describe('SamplingRate', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.25, 0.25],
    [1, 1],
    [1.5, 1],
    [100, 1],
  ])('resolve clamps rate %p to %p', (input, expected) => {
    const sampling = new SamplingRate(input);
    expect(sampling.resolve(emptyContext)).toBe(expected);
  });
});

describe('SamplingFunction', () => {
  it('clamps fn return values to [0, 1]', () => {
    const sampling = new SamplingFunction(() => -0.5);
    expect(sampling.resolve(emptyContext)).toBe(0);

    const samplingHigh = new SamplingFunction(() => 2);
    expect(samplingHigh.resolve(emptyContext)).toBe(1);
  });

  it('passes through in-range values from context', () => {
    const ctx: SamplingContext = {
      meta: { app: { environment: 'production' } },
    };
    const sampling = new SamplingFunction((c) => {
      if (c.meta.app?.environment === 'production') {
        return 0.1;
      }
      return 1;
    });
    expect(sampling.resolve(ctx)).toBe(0.1);
    expect(sampling.resolve(emptyContext)).toBe(1);
  });

  it('clamps dynamic values from context', () => {
    const sampling = new SamplingFunction((c) => (c.meta.user?.id ? 5 : -1));
    expect(sampling.resolve({ meta: { user: { id: 'u1' } } })).toBe(1);
    expect(sampling.resolve(emptyContext)).toBe(0);
  });
});
