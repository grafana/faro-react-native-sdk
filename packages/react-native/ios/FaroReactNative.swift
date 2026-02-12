import Foundation

/// Faro React Native iOS Native Module
///
/// Provides native iOS implementations for Real User Monitoring (RUM) metrics.
/// This class is called from Objective-C bridge (`FaroReactNativeModule.mm`)
/// which exports methods to JavaScript via React Native's native module system.
///
/// ## Metrics Provided
/// - **App Startup Time**: Cold start duration using kernel process info
/// - **Memory Usage**: Physical memory footprint via Mach task API
/// - **CPU Usage**: Per-process CPU percentage via thread aggregation
/// - **Session Persistence**: UserDefaults storage for crash correlation
///
/// ## Implementation Notes
/// All methods use low-level iOS/Darwin APIs for accurate measurements:
/// - `sysctl()` for process information
/// - `task_info()` for memory and thread data
/// - `UserDefaults` for persistent storage
///
/// These implementations are aligned with Grafana Faro Flutter SDK patterns
/// but include improvements where applicable (e.g., better memory metric).
@objc(FaroReactNative)
public class FaroReactNative: NSObject {

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

    /// Returns current memory usage in kilobytes.
    ///
    /// Uses `task_info()` with `TASK_VM_INFO` to get the process's physical
    /// memory footprint. This is the recommended metric for iOS memory monitoring.
    ///
    /// ## Memory Metrics Explained
    /// - **`phys_footprint`** (used here): Physical memory attributed to this app.
    ///   This is what Apple recommends and what Xcode's Memory Gauge shows.
    /// - **`resident_size`**: Physical pages currently in RAM (less accurate,
    ///   can include shared memory counted multiple times).
    ///
    /// ## RUM Best Practices
    /// - ✅ Uses `phys_footprint` (Apple-recommended metric)
    /// - ✅ Matches Xcode Memory Gauge for easy correlation
    /// - ✅ Suitable for periodic sampling (low overhead)
    ///
    /// ## Typical Values
    /// - Small apps: 50-100 MB
    /// - Medium apps: 100-300 MB
    /// - Memory warnings start around 1GB+ on modern devices
    ///
    /// - Returns: Memory usage in KB, or 0.0 on error
    @objc public static func getMemoryUsage() -> Double {
        var vmInfo = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info>.size / MemoryLayout<integer_t>.size)

        let result = withUnsafeMutablePointer(to: &vmInfo) { vmInfoPtr in
            vmInfoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { ptr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), ptr, &count)
            }
        }

        guard result == KERN_SUCCESS else {
            return 0.0
        }

        // phys_footprint is in bytes, convert to KB
        // This is the recommended iOS memory metric (matches Xcode Memory Gauge)
        let memoryBytes = Double(vmInfo.phys_footprint)
        return memoryBytes / 1024.0
    }

    // MARK: - CPU Usage

    /// Returns current CPU usage as a percentage (0-100+).
    ///
    /// Uses differential calculation - first call establishes a baseline and
    /// returns 0.0, subsequent calls return the actual CPU usage percentage.
    ///
    /// ## How It Works
    /// Delegates to `CPUInfo.getCpuInfo()` which:
    /// 1. Enumerates all threads via `task_threads()`
    /// 2. Sums CPU time (user + system) across all threads
    /// 3. Calculates percentage: `(cpuTimeDelta / wallTimeDelta) * 100`
    ///
    /// ## RUM Best Practices
    /// - ✅ Per-process CPU (not system-wide)
    /// - ✅ Per-thread aggregation (accurate on multi-core)
    /// - ✅ Differential calculation (measures actual usage between calls)
    /// - ✅ Low overhead (suitable for periodic sampling)
    ///
    /// ## Return Values
    /// - `0.0`: First call (baseline) or very low CPU usage
    /// - `0-100`: Normal CPU usage percentage
    /// - `>100`: Possible on multi-core (e.g., 200% = 2 cores fully utilized)
    /// - `-1.0`: Error occurred
    ///
    /// ## Sampling Recommendations
    /// - Sample every 1-5 seconds for general monitoring
    /// - Sample more frequently during performance investigations
    /// - First call after app start returns 0 (baseline), ignore this value
    ///
    /// - Returns: CPU usage percentage, or -1.0 on error
    @objc public static func getCpuUsage() -> Double {
        return CPUInfo.getCpuInfo()
    }

    // MARK: - Session Persistence for Crash Correlation

    /// UserDefaults key for storing the current Faro session ID.
    private static let sessionIdKey = "faro_session_id"

    /// Persists the current Faro session ID to UserDefaults.
    ///
    /// This enables crash report correlation - when a crash occurs, the app
    /// terminates before the crash can be reported. On next launch, we retrieve
    /// this persisted session ID and include it in the crash report, allowing
    /// users to query all events from the crashed session in Grafana.
    ///
    /// ## Flow
    /// ```
    /// Session A starts → persistSessionId("abc123") → UserDefaults
    /// App crashes → UserDefaults still has "abc123"
    /// App restarts → Session B starts
    /// Crash report includes crashedSessionId: "abc123"
    /// User can filter Grafana by "abc123" to see pre-crash events
    /// ```
    ///
    /// ## Implementation Notes
    /// - Called only when a new session starts (not on every activity update)
    /// - Uses `synchronize()` for crash resilience (writes immediately to disk)
    /// - Mirrors Android implementation using SharedPreferences
    ///
    /// - Parameter sessionId: The current Faro session ID to persist
    @objc public static func persistSessionId(_ sessionId: String) {
        UserDefaults.standard.set(sessionId, forKey: sessionIdKey)
        // synchronize() ensures data is written to disk immediately
        // This is important for crash scenarios where the app may terminate
        // before the normal background save occurs
        UserDefaults.standard.synchronize()
    }

    /// Retrieves the persisted session ID from UserDefaults.
    ///
    /// Called during crash report processing to get the session ID that was
    /// active when the crash occurred. This enables correlation between the
    /// crash report (sent in new session) and events from the crashed session.
    ///
    /// - Returns: The persisted session ID, or nil if none found
    @objc public static func getPersistedSessionId() -> String? {
        return UserDefaults.standard.string(forKey: sessionIdKey)
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
    /// - `crashedSessionId`: The Faro session ID when the crash occurred
    ///
    /// After calling this method, pending crash reports are purged.
    ///
    /// - Returns: Array of crash report JSON strings, or nil if no crashes
    @objc public static func getCrashReports() -> [String]? {
        return FaroCrashReporter.getCrashReports()
    }
}
