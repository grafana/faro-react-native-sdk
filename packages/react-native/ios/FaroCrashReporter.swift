import CrashReporter
import Foundation

/// iOS Crash Reporter using PLCrashReporter.
///
/// This class handles:
/// 1. Enabling PLCrashReporter to capture crashes
/// 2. Loading and parsing crash reports from previous sessions
/// 3. Converting crash data to JSON format compatible with Faro
/// 4. Including session ID for crash correlation in Grafana
///
/// ## Architecture
/// PLCrashReporter captures crashes using signal handlers (BSD signals like SIGSEGV, SIGABRT)
/// and Mach exception handlers. When a crash occurs, it writes a crash report to disk.
/// On the next app launch, we load this report, convert it to JSON, and return it to
/// JavaScript for sending to the Faro collector.
///
/// ## Usage
/// This is called automatically by the CrashReportingInstrumentation in TypeScript.
@objc(FaroCrashReporter)
public class FaroCrashReporter: NSObject {

    private static var crashReporter: PLCrashReporter?
    private static var isEnabled = false

    /// Signal descriptions for human-readable crash messages.
    private static let signalDescriptions: [String: String] = [
        "SIGHUP": "Hangup",
        "SIGINT": "Interrupt",
        "SIGQUIT": "Quit",
        "SIGILL": "Illegal instruction",
        "SIGTRAP": "Trace/BPT trap",
        "SIGABRT": "Abort trap",
        "SIGEMT": "EMT trap",
        "SIGFPE": "Floating point exception",
        "SIGKILL": "Killed",
        "SIGBUS": "Bus error",
        "SIGSEGV": "Segmentation fault",
        "SIGSYS": "Bad system call",
        "SIGPIPE": "Broken pipe",
        "SIGALRM": "Alarm clock",
        "SIGTERM": "Terminated"
    ]

    // MARK: - Public API

    /// Enables crash reporting using PLCrashReporter.
    ///
    /// This should be called early in the app lifecycle. It sets up signal handlers
    /// to capture crashes. Safe to call multiple times - will only enable once.
    ///
    /// - Returns: true if successfully enabled, false otherwise
    @objc public static func enable() -> Bool {
        guard !isEnabled else {
            return true
        }

        guard let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            print("[FaroCrashReporter] Cannot access cache directory")
            return false
        }

        let crashDir = cacheDir.appendingPathComponent("com.grafana.faro.crash-reporting", isDirectory: true)

        // Create crash directory if needed
        try? FileManager.default.createDirectory(at: crashDir, withIntermediateDirectories: true)

        // Configure PLCrashReporter
        // Using BSD signal handler for broader compatibility
        // Empty symbolication strategy - we'll handle that server-side
        let config = PLCrashReporterConfig(
            signalHandlerType: .BSD,
            symbolicationStrategy: [],
            basePath: crashDir.path
        )

        guard let reporter = PLCrashReporter(configuration: config) else {
            print("[FaroCrashReporter] Could not create PLCrashReporter instance")
            return false
        }

        do {
            try reporter.enableAndReturnError()
            crashReporter = reporter
            isEnabled = true
            print("[FaroCrashReporter] Successfully enabled crash reporting")
            return true
        } catch {
            print("[FaroCrashReporter] Failed to enable: \(error)")
            return false
        }
    }

    /// Gets crash reports from previous sessions as JSON strings.
    ///
    /// Returns an array of JSON strings, each representing a crash report.
    /// The JSON format matches the Android implementation for consistency.
    /// Includes the crashed session ID if available for correlation.
    ///
    /// After calling this method, pending crash reports are purged.
    ///
    /// - Returns: Array of crash report JSON strings, or nil if no crashes
    @objc public static func getCrashReports() -> [String]? {
        // Ensure crash reporter is enabled
        guard enable() else {
            return nil
        }

        guard let reporter = crashReporter else {
            return nil
        }

        guard reporter.hasPendingCrashReport() else {
            return nil
        }

        var crashReports: [String] = []

        do {
            let data = try reporter.loadPendingCrashReportDataAndReturnError()
            let plcrReport = try PLCrashReport(data: data)
            let crashReport = try FaroCrashReport(from: plcrReport)

            // Get the persisted session ID from when the crash occurred
            let crashedSessionId = FaroReactNative.getPersistedSessionId()

            // Convert to JSON matching Android format
            if let jsonString = exportCrashReportAsJSON(crashReport, crashedSessionId: crashedSessionId) {
                crashReports.append(jsonString)
            }
        } catch {
            print("[FaroCrashReporter] Failed to load crash report: \(error)")
        }

        // Purge the crash report after loading
        reporter.purgePendingCrashReport()

        return crashReports.isEmpty ? nil : crashReports
    }

    // MARK: - Private Helpers

    /// Converts a FaroCrashReport to JSON string matching the Android format.
    private static func exportCrashReportAsJSON(_ crashReport: FaroCrashReport, crashedSessionId: String?) -> String? {
        var json: [String: Any] = [:]

        // Reason - matches Android's "reason" field
        // For iOS, we use the signal name as the reason
        let signalName = crashReport.signalInfo?.name ?? "UNKNOWN"
        json["reason"] = signalName

        // Timestamp - Unix timestamp in milliseconds
        if let timestamp = crashReport.systemInfo?.timestamp {
            json["timestamp"] = Int64(timestamp.timeIntervalSince1970 * 1000)
        }

        // Status - iOS doesn't have exit status like Android, use signal code
        json["status"] = 0

        // Description - human-readable crash description
        json["description"] = formattedDescription(for: crashReport)

        // Process info
        if let processInfo = crashReport.processInfo {
            json["processName"] = processInfo.processName ?? ""
            json["pid"] = processInfo.processID
        }

        // Signal info (iOS-specific)
        if let signalInfo = crashReport.signalInfo {
            json["signal"] = "\(signalInfo.name ?? "UNKNOWN") (\(signalInfo.code ?? ""))"
        }

        // Include crashed session ID for correlation in Grafana
        if let sessionId = crashedSessionId, !sessionId.isEmpty {
            json["crashedSessionId"] = sessionId
        }

        // Stack trace as a string (similar to Android's trace field)
        let trace = formattedStackTrace(for: crashReport)
        if !trace.isEmpty {
            json["trace"] = trace
        }

        // Incident identifier
        if let incidentId = crashReport.incidentIdentifier {
            json["incidentId"] = incidentId
        }

        // Convert to JSON string
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: json, options: [])
            return String(data: jsonData, encoding: .utf8)
        } catch {
            print("[FaroCrashReporter] Failed to serialize crash report: \(error)")
            return nil
        }
    }

    /// Creates a human-readable description of the crash.
    ///
    /// This returns just the descriptive portion. The TypeScript layer formats the
    /// final error message as "{reason}: {description}, status: {status}" to match
    /// the Flutter SDK pattern.
    private static func formattedDescription(for crashReport: FaroCrashReport) -> String {
        // If there's an uncaught exception, include the exception details
        if let exception = crashReport.exceptionInfo {
            let name = exception.name ?? "Unknown"
            let reason = exception.reason ?? "Unknown reason"
            return "Uncaught exception '\(name)': \(reason)"
        }

        // Otherwise, provide a signal-based description
        // The 'reason' field contains the signal name (e.g., SIGSEGV),
        // so the description provides additional context
        if let signalName = crashReport.signalInfo?.name,
           let signalDescription = signalDescriptions[signalName] {
            return signalDescription
        }

        return "Application crash"
    }

    /// Formats the stack trace as a string for the trace field.
    private static func formattedStackTrace(for crashReport: FaroCrashReport) -> String {
        // Get the most meaningful stack trace:
        // 1. Exception stack trace (if available)
        // 2. Crashed thread stack trace
        // 3. First thread stack trace (fallback)
        let stackFrames: [FaroStackFrame]?

        if let exceptionFrames = crashReport.exceptionInfo?.stackFrames, !exceptionFrames.isEmpty {
            stackFrames = exceptionFrames
        } else if let crashedThread = crashReport.threads.first(where: { $0.crashed }) {
            stackFrames = crashedThread.stackFrames
        } else {
            stackFrames = crashReport.threads.first?.stackFrames
        }

        guard let frames = stackFrames, !frames.isEmpty else {
            return ""
        }

        // Format similar to iOS crash logs
        var lines: [String] = []
        for frame in frames.prefix(50) { // Limit to 50 frames
            let library = frame.libraryName ?? "???"
            let address = String(format: "0x%016llx", frame.instructionPointer)
            lines.append("\(frame.number)  \(library)  \(address)")
        }

        return lines.joined(separator: "\n")
    }
}
