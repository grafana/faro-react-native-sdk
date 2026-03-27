import { initializeFaro } from '@grafana/faro-core';
import { mockConfig } from '@grafana/faro-test-utils';

import { SamplingFunction, SamplingRate } from '../../../config/sampling';

import { isSampled } from './sampling';

describe('Sampling', () => {
  afterEach(() => {
    jest.spyOn(global.Math, 'random').mockRestore();
  });

  it('defaults to sampling all (1) when no sampling configured', () => {
    const config = mockConfig({
      sessionTracking: {
        enabled: true,
      },
    });

    initializeFaro(config);
    expect(isSampled()).toBe(true);
  });

  describe('Sampling interface (Flutter-style)', () => {
    it('SamplingRate(1) samples all sessions', () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingRate(1),
        },
      });

      initializeFaro(config);
      expect(isSampled()).toBe(true);
    });

    it('SamplingRate(0) samples no sessions', () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingRate(0),
        },
      });

      initializeFaro(config);
      expect(isSampled()).toBe(false);
    });

    it('SamplingRate uses Math.random for probabilistic decision', () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingRate(0.5),
        },
      });

      initializeFaro(config);

      jest.spyOn(global.Math, 'random').mockReturnValue(0.4);
      expect(isSampled()).toBe(true);

      jest.spyOn(global.Math, 'random').mockReturnValue(0.6);
      expect(isSampled()).toBe(false);
    });

    it('SamplingFunction receives context with meta', () => {
      const fn = jest.fn(() => 1);
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingFunction(fn),
        },
      });

      initializeFaro(config);
      isSampled();

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.any(Object),
        })
      );
    });

    it('SamplingFunction can use context.meta for decision', () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingFunction((context) => (context.meta.app?.environment === 'production' ? 0.1 : 1)),
        },
      });

      const faro = initializeFaro(config);

      // With production env - use 0.1 rate; with random 0.05 < 0.1, should sample
      faro.metas.add({ app: { name: 'test', version: '1', environment: 'production' } });
      jest.spyOn(global.Math, 'random').mockReturnValue(0.05);
      expect(isSampled()).toBe(true);

      // With random 0.5 >= 0.1, should not sample
      jest.spyOn(global.Math, 'random').mockReturnValue(0.5);
      expect(isSampled()).toBe(false);
    });

    it('custom Sampling implementation works', () => {
      const customSampling = {
        resolve: jest.fn(() => 1),
      };
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: customSampling,
        },
      });

      initializeFaro(config);
      isSampled();

      expect(customSampling.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.any(Object),
        })
      );
      expect(isSampled()).toBe(true);
    });

    it('returns false when Sampling.resolve returns non-number', () => {
      const config = mockConfig({
        sessionTracking: {
          enabled: true,
          sampling: new SamplingFunction(() => 'invalid' as unknown as number),
        },
      });

      initializeFaro(config);
      expect(isSampled()).toBe(false);
    });
  });
});
