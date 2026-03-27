#import <React/RCTBridgeModule.h>

/**
 * Objective-C bridge for CrashTestModule.
 *
 * This exposes the Swift CrashTestModule to React Native's JavaScript layer.
 * The actual implementation is in CrashTestModule.swift.
 */
@interface RCT_EXTERN_MODULE(CrashTestModule, NSObject)

/**
 * Trigger a test crash (fatal error).
 * WARNING: This will immediately terminate the app!
 */
RCT_EXTERN_METHOD(triggerTestCrash)

/**
 * Trigger a main thread freeze by performing heavy computation.
 * Allows FrameMonitoringInstrumentation to detect frozen frames.
 * WARNING: This will freeze the app for ~3 seconds!
 */
RCT_EXTERN_METHOD(triggerFreeze)

/**
 * Trigger slow frames by doing moderate CPU work on main thread.
 * Creates janky animations for ~5 seconds.
 * WARNING: This will cause choppy UI!
 */
RCT_EXTERN_METHOD(triggerSlowFrames)

/**
 * Trigger heavy load with mixed slow frames and freezes.
 * Simulates worst-case performance for ~10 seconds.
 * WARNING: This will cause severe performance issues!
 */
RCT_EXTERN_METHOD(triggerHeavyLoad)

@end
