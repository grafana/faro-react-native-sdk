import type { Meta } from '@grafana/faro-core';

/**
 * Context passed to sampling implementations.
 *
 * Provides access to the current metadata state at SDK initialization time,
 * allowing sampling decisions based on session attributes, user info, app
 * environment, and other metadata.
 *
 * This aligns with the Faro Flutter SDK's `SamplingContext` which provides
 * `meta` to the sampler.
 *
 * @example
 * ```ts
 * sampling: SamplingFunction((context) => {
 *   // Sample all beta users
 *   if (context.meta.user?.attributes?.['role'] === 'beta') {
 *     return 1;
 *   }
 *   // Sample 10% of production sessions
 *   if (context.meta.app?.environment === 'production') {
 *     return 0.1;
 *   }
 *   return 1;
 * })
 * ```
 */
export interface SamplingContext {
  /** The current merged metadata state (session, user, app, sdk, view). */
  meta: Meta;
}

/**
 * Defines how sessions should be sampled.
 *
 * Implement this interface to provide custom sampling logic. Use one of the
 * built-in implementations:
 * - {@link SamplingRate} for a fixed sampling rate
 * - {@link SamplingFunction} for dynamic sampling based on context
 *
 * @example
 * ```ts
 * // Fixed 10% sampling
 * sessionTracking: {
 *   sampling: new SamplingRate(0.1),
 * }
 *
 * // Dynamic sampling based on context
 * sessionTracking: {
 *   sampling: new SamplingFunction((context) => {
 *     if (context.meta.app?.environment === 'production') {
 *       return 0.1;
 *     }
 *     return 1;
 *   }),
 * }
 *
 * // Custom implementation
 * class BetaUserSampling implements Sampling {
 *   resolve(context: SamplingContext): number {
 *     return context.meta.user?.attributes?.['role'] === 'beta' ? 1 : 0.1;
 *   }
 * }
 * sessionTracking: { sampling: new BetaUserSampling() }
 * ```
 */
export interface Sampling {
  /**
   * Resolves the sampling rate for the given context.
   *
   * @param context - The current metadata state
   * @returns A value between 0 and 1 (inclusive). Values are clamped to [0, 1].
   *   - 1: Sample all sessions (100%)
   *   - 0.5: Sample half of sessions (50%)
   *   - 0: Sample no sessions (0%)
   */
  resolve(context: SamplingContext): number;
}

/**
 * Fixed sampling rate.
 *
 * Use this when you want a constant sampling probability regardless of
 * session context.
 *
 * @example
 * ```ts
 * sessionTracking: {
 *   sampling: new SamplingRate(0.1), // 10% of sessions
 * }
 * ```
 */
export class SamplingRate implements Sampling {
  /**
   * Creates a fixed sampling rate.
   *
   * @param rate - The fixed sampling rate (0 to 1). Values are clamped to [0, 1].
   */
  constructor(public readonly rate: number) {}

  resolve(_context: SamplingContext): number {
    return Math.max(0, Math.min(1, this.rate));
  }
}

/**
 * Dynamic sampling based on context.
 *
 * Use this when you want to make sampling decisions based on session
 * metadata like user attributes, app environment, or other context.
 *
 * @example
 * ```ts
 * sessionTracking: {
 *   sampling: new SamplingFunction((context) => {
 *     // Sample all beta users
 *     if (context.meta.user?.attributes?.['role'] === 'beta') {
 *       return 1;
 *     }
 *     // Sample 10% of production sessions
 *     if (context.meta.app?.environment === 'production') {
 *       return 0.1;
 *     }
 *     return 1;
 *   }),
 * }
 * ```
 */
export class SamplingFunction implements Sampling {
  /**
   * Creates a dynamic sampler with the given function.
   *
   * @param fn - The function that determines the rate based on context.
   *   Receives a {@link SamplingContext} and should return a rate between 0 and 1.
   */
  constructor(private readonly fn: (context: SamplingContext) => number) {}

  resolve(context: SamplingContext): number {
    return Math.max(0, Math.min(1, this.fn(context)));
  }
}
