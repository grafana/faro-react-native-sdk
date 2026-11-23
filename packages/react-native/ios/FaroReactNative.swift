import Foundation
import UIKit

/// Faro React Native iOS Native Module
///
/// Provides native iOS implementations for Real User Monitoring (RUM) metrics.
/// This class is called from Objective-C bridge (`FaroReactNativeModule.mm`)
/// which exports methods to JavaScript via React Native's native module system.
///
/// ## Metrics Provided
/// - **App Startup Time**: Cold start duration using kernel process info
/// - **Memory Usage**: Physical memory footprint via Mach task API
/// - **CPU Usage**: Task CPU counters are read by CPUInfo on a background queue
///
/// ## Implementation Notes
/// All methods use low-level iOS/Darwin APIs for accurate measurements:
/// - `sysctl()` for process information
/// - `task_info()` for memory and thread data
///
/// These implementations are aligned with Grafana Faro Flutter SDK patterns
/// but include improvements where applicable (e.g., better memory metric).
@objc(FaroReactNative)
public class FaroReactNative: NSObject {
    /// Stable bundle identity used to isolate persisted session chains.
    @objc public static func getSessionProcessIdentifier() -> String {
        return Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName
    }

    /// App extensions have an NSExtension dictionary in their main bundle.
    @objc public static func isMainSessionProcess() -> Bool {
        return Bundle.main.object(forInfoDictionaryKey: "NSExtension") == nil
    }

    // MARK: - CPU Architecture

    /// The architecture this process is built for, such as "arm64".
    ///
    /// iOS has no runtime call that returns an architecture string, so the
    /// compiler sets this value. iOS runs no 32-bit apps, so this is also the
    /// device's architecture, except for an x86_64 simulator under Rosetta.
    @objc public static func getCpuArchitecture() -> String? {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return nil
        #endif
    }

    // MARK: - Screen

    /// The screen size in physical pixels and the native scale, such as 1206 × 2622 at 3.0.
    ///
    /// nativeBounds is the physical panel size, always in portrait. bounds × scale rotates with
    /// the interface and is not the panel size on Plus models or with Display Zoom on.
    @MainActor @objc public static func getScreenMetrics() -> [String: NSNumber] {
        let screen = UIScreen.main
        return [
            "width": NSNumber(value: Int(screen.nativeBounds.width)),
            "height": NSNumber(value: Int(screen.nativeBounds.height)),
            "density": NSNumber(value: Double(screen.nativeScale)),
        ]
    }

    // MARK: - App Startup Time

    /// Returns the app's cold start duration in milliseconds.
    ///
    /// Uses `sysctl()` to query the kernel for the actual process start time.
    /// This approach requires no manual initialization in AppDelegate - the OS
    /// tracks process creation time automatically.
    ///
    /// ## How It Works
    /// 1. Queries kernel via `sysctl()` for `kinfo_proc.kp_proc.p_starttime`
    /// 2. Gets current wall clock time via `gettimeofday()`
    /// 3. Returns the difference in milliseconds
    ///
    /// ## RUM Best Practices
    /// - ✅ Uses OS-level timing (most accurate)
    /// - ✅ No manual instrumentation required
    /// - ✅ Works for cold starts
    /// - ⚠️ For warm starts, additional app lifecycle tracking is needed
    ///
    /// ## When to Call
    /// Call this after the app's UI is interactive (e.g., after first render)
    /// to measure Time-To-Interactive (TTI).
    ///
    /// - Returns: Duration from process start to now in milliseconds
    @objc public static func getAppStartDuration() -> Double {
        var kinfo = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]

        let result = sysctl(&mib, u_int(mib.count), &kinfo, &size, nil, 0)
        guard result == 0 else {
            return 0.0
        }

        let startTime = kinfo.kp_proc.p_starttime
        var currentTime = timeval(tv_sec: 0, tv_usec: 0)
        gettimeofday(&currentTime, nil)

        let currentTimeMs = Double(Int64(currentTime.tv_sec) * 1000) + Double(currentTime.tv_usec) / 1000.0
        let processStartMs = Double(Int64(startTime.tv_sec) * 1000) + Double(startTime.tv_usec) / 1000.0

        return currentTimeMs - processStartMs
    }

    // MARK: - Memory Usage

    /// Physical footprint in bytes, or nil on failure. Called on a background queue.
    @objc public static func getMemoryUsage() -> NSNumber? {
        var vmInfo = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info>.size / MemoryLayout<integer_t>.size)

        let result = withUnsafeMutablePointer(to: &vmInfo) { vmInfoPtr in
            vmInfoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { ptr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), ptr, &count)
            }
        }

        guard result == KERN_SUCCESS, vmInfo.phys_footprint > 0 else {
            return nil
        }

        return NSNumber(value: vmInfo.phys_footprint)
    }

    // MARK: - Crash Reporting

    /// Enables crash reporting using PLCrashReporter.
    ///
    /// This sets up signal handlers to capture crashes (SIGSEGV, SIGABRT, etc.)
    /// and Mach exceptions. Should be called early in the app lifecycle.
    ///
    /// - Returns: true if successfully enabled, false otherwise
    @objc public static func enableCrashReporting() -> Bool {
        return FaroCrashReporter.enable()
    }

    /// Gets crash reports from previous sessions as JSON strings.
    ///
    /// Returns an array of JSON strings, each representing a crash report.
    /// The JSON format matches the Android implementation for consistency:
    /// - `reason`: Signal name (e.g., "SIGSEGV", "SIGABRT")
    /// - `timestamp`: Unix timestamp in milliseconds
    /// - `description`: Human-readable crash description
    /// - `trace`: Stack trace as string
    /// - `signal`: Signal info (iOS-specific)
    ///
    /// After calling this method, pending crash reports are purged.
    ///
    /// - Returns: Array of crash report JSON strings, or nil if no crashes
    @objc public static func getCrashReports() -> [String]? {
        return FaroCrashReporter.getCrashReports()
    }

    /// Records the active Faro session in PLCrashReporter's custom crash data.
    @objc public static func recordCrashSessionContext(_ sessionContext: [String: Any]) -> Bool {
        return FaroCrashReporter.recordSessionContext(sessionContext)
    }

    /// Gets pending crash reports without deleting them.
    @objc public static func getPendingCrashReports() -> [String]? {
        return FaroCrashReporter.getPendingCrashReports()
    }

    /// Purges only the pending report whose stable ID was acknowledged.
    @objc public static func acknowledgeCrashReports(_ reportIds: [String]) -> Bool {
        return FaroCrashReporter.acknowledgeCrashReports(reportIds)
    }
}
