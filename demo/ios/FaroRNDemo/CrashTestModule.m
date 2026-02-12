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
 * Trigger an ANR-like freeze by blocking the main thread for 10 seconds.
 * WARNING: This will freeze the app!
 */
RCT_EXTERN_METHOD(triggerANR)

@end
