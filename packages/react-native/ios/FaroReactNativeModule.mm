#import "FaroReactNativeModule.h"
#import <React/RCTBridgeModule.h>
#import "FaroReactNative-Swift.h"

static NSLock *FaroSessionPersistenceLock(void)
{
  static NSLock *lock;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    lock = [[NSLock alloc] init];
  });
  return lock;
}

static __weak FaroReactNativeModule *FaroSessionPersistenceOwner;

@interface FaroReactNativeModule ()
- (BOOL)claimSessionPersistenceOwnership;
- (BOOL)releaseSessionPersistenceOwnership;
@end

@implementation FaroReactNativeModule

RCT_EXPORT_MODULE(FaroReactNativeModule)

/// Stable process identity used to isolate persisted session chains.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getSessionProcessIdentifier)
{
  return [FaroReactNative getSessionProcessIdentifier];
}

/// Whether this runtime belongs to the host application's main process.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(isMainSessionProcess)
{
  return @([FaroReactNative isMainSessionProcess]);
}

/// Allows only one React Native runtime in a process to persist sessions.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(claimSessionPersistence)
{
  return @([self claimSessionPersistenceOwnership]);
}

/// Releases persistence only when this native module instance owns it.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(releaseSessionPersistence)
{
  return @([self releaseSessionPersistenceOwnership]);
}

- (BOOL)claimSessionPersistenceOwnership
{
  NSLock *lock = FaroSessionPersistenceLock();
  [lock lock];
  BOOL claimed = FaroSessionPersistenceOwner == nil || FaroSessionPersistenceOwner == self;
  if (claimed) {
    FaroSessionPersistenceOwner = self;
  }
  [lock unlock];
  return claimed;
}

- (BOOL)releaseSessionPersistenceOwnership
{
  NSLock *lock = FaroSessionPersistenceLock();
  [lock lock];
  BOOL released = FaroSessionPersistenceOwner == self;
  if (released) {
    FaroSessionPersistenceOwner = nil;
  }
  [lock unlock];
  return released;
}

- (void)invalidate
{
  [self releaseSessionPersistenceOwnership];
}

- (void)dealloc
{
  [self releaseSessionPersistenceOwnership];
}

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
  double targetFps = [[config objectForKey:@"targetFps"] doubleValue] ?: RefreshRateVitals.defaultTargetFps;
  double frozenFrameThresholdMs = [[config objectForKey:@"frozenFrameThresholdMs"] doubleValue] ?: RefreshRateVitals.defaultFrozenFrameThresholdMs;
  double normalizedRefreshRate = [[config objectForKey:@"normalizedRefreshRate"] doubleValue] ?: RefreshRateVitals.defaultNormalizedRefreshRate;
  
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

/// Get frame metrics (refresh rate, slow frame events, frozen frames, frozen duration)
/// Note: slowFrames contains the count of slow frame EVENTS (not individual frames)
/// @param resolve Promise resolve callback
/// @param reject Promise reject callback
RCT_EXPORT_METHOD(getFrameMetrics:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    RefreshRateVitals *vitals = [RefreshRateVitals shared];
    NSDictionary *frozenMetrics = [vitals getAndResetFrozenMetrics];

    NSDictionary *metrics = @{
      @"refreshRate": @([vitals getRefreshRate]),
      @"slowFrames": @([vitals getAndResetSlowFrames]),
      @"frozenFrames": frozenMetrics[@"count"],
      @"frozenDurationMs": frozenMetrics[@"durationMs"]
    };
    
    resolve(metrics);
  });
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

/// Store the active session synchronously so it is available if the process crashes.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(recordCrashSessionContext:(NSDictionary *)sessionContext)
{
  return @([FaroReactNative recordCrashSessionContext:sessionContext]);
}

/// Get pending crash reports without deleting them.
RCT_EXPORT_METHOD(getPendingCrashReports:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSArray<NSString *> *crashReports = [FaroReactNative getPendingCrashReports];
  if (crashReports != nil && crashReports.count > 0) {
    resolve(crashReports);
  } else {
    resolve([NSNull null]);
  }
}

/// Delete only crash reports that JavaScript has finished handling.
RCT_EXPORT_METHOD(acknowledgeCrashReports:(NSArray *)reportIds
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSMutableArray<NSString *> *sanitizedReportIds = [NSMutableArray array];
  for (id reportId in reportIds) {
    if (![reportId isKindOfClass:[NSString class]]) {
      continue;
    }

    NSString *trimmedReportId = [(NSString *)reportId stringByTrimmingCharactersInSet:
                                 [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmedReportId.length > 0) {
      [sanitizedReportIds addObject:trimmedReportId];
    }
  }

  if ([FaroReactNative acknowledgeCrashReports:sanitizedReportIds]) {
    resolve([NSNull null]);
  } else {
    reject(@"E_CRASH_ACK_FAILED", @"Failed to acknowledge recovered crash report", nil);
  }
}

@end
