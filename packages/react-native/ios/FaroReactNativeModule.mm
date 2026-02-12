#import "FaroReactNativeModule.h"
#import <React/RCTBridgeModule.h>
#import "FaroReactNative-Swift.h"

@implementation FaroReactNativeModule

RCT_EXPORT_MODULE(FaroReactNativeModule)

/// Synchronous method for immediate access from JavaScript
/// Returns app startup duration in milliseconds from process start to current time
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getAppStartDuration)
{
  return @([FaroReactNative getAppStartDuration]);
}

/// Synchronous method for immediate access from JavaScript
/// Returns current memory usage in kilobytes (RSS)
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getMemoryUsage)
{
  return @([FaroReactNative getMemoryUsage]);
}

/// Synchronous method for immediate access from JavaScript
/// Returns current CPU usage percentage (0-100+), or -1 on error
/// First call returns 0 (baseline), subsequent calls return actual usage
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCpuUsage)
{
  double cpuUsage = [FaroReactNative getCpuUsage];
  // Return null for error case (-1.0) to match JavaScript expectations
  return cpuUsage < 0 ? [NSNull null] : @(cpuUsage);
}

/// Start frame monitoring with configuration
/// @param config Dictionary with targetFps, frozenFrameThresholdMs, normalizedRefreshRate
RCT_EXPORT_METHOD(startFrameMonitoring:(NSDictionary *)config)
{
  double targetFps = [[config objectForKey:@"targetFps"] doubleValue] ?: 60.0;
  double frozenFrameThresholdMs = [[config objectForKey:@"frozenFrameThresholdMs"] doubleValue] ?: 100.0;
  double normalizedRefreshRate = [[config objectForKey:@"normalizedRefreshRate"] doubleValue] ?: 60.0;
  
  dispatch_async(dispatch_get_main_queue(), ^{
    [[RefreshRateVitals shared] configureWithTargetFps:targetFps
                               frozenFrameThresholdMs:frozenFrameThresholdMs
                               normalizedRefreshRate:normalizedRefreshRate];
    [[RefreshRateVitals shared] start];
  });
}

/// Stop frame monitoring
RCT_EXPORT_METHOD(stopFrameMonitoring)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[RefreshRateVitals shared] stop];
  });
}

/// Get current refresh rate
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(getRefreshRate:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    double refreshRate = [[RefreshRateVitals shared] getRefreshRate];
    if (refreshRate > 0) {
      resolve(@(refreshRate));
    } else {
      resolve([NSNull null]);
    }
  });
}

/// Get frame metrics (refresh rate, slow frames, frozen frames)
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(getFrameMetrics:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    RefreshRateVitals *vitals = [RefreshRateVitals shared];
    
    NSDictionary *metrics = @{
      @"refreshRate": @([vitals getRefreshRate]),
      @"slowFrames": @([vitals getAndResetSlowFrames]),
      @"frozenFrames": @([vitals getAndResetFrozenFrames])
    };
    
    resolve(metrics);
  });
}

/// Persist the current Faro session ID to UserDefaults for crash correlation.
/// This allows crash reports to include the session ID where the crash occurred.
/// @param sessionId The current Faro session ID
RCT_EXPORT_METHOD(persistSessionId:(NSString *)sessionId)
{
  [FaroReactNative persistSessionId:sessionId];
}

/// Get the persisted session ID from UserDefaults.
/// Used by crash reporting to correlate crashes with the original session.
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(getPersistedSessionId:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSString *sessionId = [FaroReactNative getPersistedSessionId];
  if (sessionId != nil) {
    resolve(sessionId);
  } else {
    resolve([NSNull null]);
  }
}

// MARK: - Crash Reporting

/// Enable crash reporting using PLCrashReporter.
/// Sets up signal handlers to capture crashes (SIGSEGV, SIGABRT, etc.).
/// Should be called early in the app lifecycle.
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(enableCrashReporting:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  BOOL success = [FaroReactNative enableCrashReporting];
  resolve(@(success));
}

/// Get crash reports from previous app sessions.
/// Uses PLCrashReporter to capture signal crashes and Mach exceptions.
/// Returns an array of JSON strings matching the Android format.
/// Includes crashedSessionId for correlation in Grafana dashboards.
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(getCrashReport:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSArray<NSString *> *crashReports = [FaroReactNative getCrashReports];
  if (crashReports != nil && crashReports.count > 0) {
    resolve(crashReports);
  } else {
    resolve([NSNull null]);
  }
}

@end
