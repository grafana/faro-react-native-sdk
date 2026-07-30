import CrashReporter
import Foundation

/// iOS Crash Reporter using PLCrashReporter.
///
/// This class handles:
/// 1. Enabling PLCrashReporter to capture crashes
/// 2. Loading and parsing crash reports from previous sessions
/// 3. Converting crash data to JSON format compatible with Faro
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
    private static let stateLock = NSLock()
    private static let sessionContextKeys = [
        "sessionId",
        "activatedAt",
        "isSampled",
        "appVersion",
        "appRelease",
        "appBundleId"
    ]

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
        stateLock.lock()
        defer { stateLock.unlock() }
        return enableLocked()
    }

    private static func enableLocked() -> Bool {
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

    /// Records the active Faro session in PLCrashReporter's crash-safe custom data.
    ///
    /// PLCrashReporter copies this data into the report at crash time, allowing a
    /// recovered crash to retain its original session after the app restarts.
    ///
    /// - Parameter sessionContext: Sanitized session and app fields from JavaScript
    /// - Returns: true when the context was stored, false when it was invalid
    @objc public static func recordSessionContext(_ sessionContext: [String: Any]) -> Bool {
        let sanitizedContext = sanitizeSessionContext(sessionContext)
        guard sanitizedContext["sessionId"] != nil,
              JSONSerialization.isValidJSONObject(sanitizedContext) else {
            return false
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: sanitizedContext)
            stateLock.lock()
            defer { stateLock.unlock() }
            guard enableLocked(), let reporter = crashReporter else {
                return false
            }
            reporter.customData = data
            return true
        } catch {
            print("[FaroCrashReporter] Failed to serialize crash session context: \(error)")
            return false
        }
    }

    /// Gets crash reports from previous sessions without deleting them.
    ///
    /// JavaScript acknowledges a report only after successful delivery or an
    /// intentional local discard.
    ///
    /// - Returns: Array of crash report JSON strings, or nil if no crashes
    @objc public static func getPendingCrashReports() -> [String]? {
        guard let reporter = enabledReporter(), reporter.hasPendingCrashReport() else {
            return nil
        }

        do {
            let data = try reporter.loadPendingCrashReportDataAndReturnError()
            let reportId = reportIdentifier(for: data)

            do {
                let plcrReport = try PLCrashReport(data: data)
                let crashReport = try FaroCrashReport(from: plcrReport)
                if let json = exportCrashReportAsJSON(crashReport, reportId: reportId) {
                    return [json]
                }
            } catch {
                print("[FaroCrashReporter] Failed to parse pending crash report: \(error)")
            }

            // Return a stable marker so JavaScript can acknowledge an unreadable
            // report rather than assigning it to the new session or retrying forever.
            return [malformedReportJSON(reportId: reportId)]
        } catch {
            print("[FaroCrashReporter] Failed to load pending crash report: \(error)")
            _ = purgeUnreadablePendingReport(reporter)
            return nil
        }
    }

    /// Purges the pending report only when its stable ID was acknowledged.
    ///
    /// - Parameter reportIds: Stable IDs handled by JavaScript
    /// - Returns: true when no matching report remains or the matching report was purged
    @objc public static func acknowledgeCrashReports(_ reportIds: [String]) -> Bool {
        guard let reporter = enabledReporter() else {
            return false
        }
        guard reporter.hasPendingCrashReport() else {
            return true
        }

        let acknowledgedIds = Set(
            reportIds
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
        guard !acknowledgedIds.isEmpty else {
            return true
        }

        do {
            let data = try reporter.loadPendingCrashReportDataAndReturnError()
            guard acknowledgedIds.contains(reportIdentifier(for: data)) else {
                return true
            }
            return reporter.purgePendingCrashReport()
        } catch {
            print("[FaroCrashReporter] Failed to acknowledge pending crash report: \(error)")
            return purgeUnreadablePendingReport(reporter)
        }
    }

    /// Gets crash reports from previous sessions as JSON strings.
    ///
    /// Returns an array of JSON strings, each representing a crash report.
    /// The JSON format matches the Android implementation for consistency.
    /// This legacy API eagerly purges returned reports for older JavaScript bundles
    /// that cannot acknowledge delivery.
    ///
    /// - Returns: Array of crash report JSON strings, or nil if no crashes
    @objc public static func getCrashReports() -> [String]? {
        guard let crashReports = getPendingCrashReports() else {
            return nil
        }

        let reportIds = crashReports.compactMap(reportIdentifier(from:))
        _ = acknowledgeCrashReports(reportIds)
        return crashReports
    }

    // MARK: - Private Helpers

    private static func enabledReporter() -> PLCrashReporter? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard enableLocked() else {
            return nil
        }
        return crashReporter
    }

    private static func purgeUnreadablePendingReport(_ reporter: PLCrashReporter) -> Bool {
        let purged = reporter.purgePendingCrashReport()
        if !purged {
            print("[FaroCrashReporter] Failed to purge unreadable pending crash report")
        }
        return purged
    }

    /// Converts a FaroCrashReport to JSON string matching the Android format.
    private static func exportCrashReportAsJSON(_ crashReport: FaroCrashReport, reportId: String) -> String? {
        var json: [String: Any] = [:]
        json["reportId"] = reportId

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

        // Stack trace as a string (similar to Android's trace field)
        let trace = formattedStackTrace(for: crashReport)
        if !trace.isEmpty {
            json["trace"] = trace
        }

        // Incident identifier
        if let incidentId = crashReport.incidentIdentifier {
            json["incidentId"] = incidentId
        }

        if let sessionContext = decodeSessionContext(crashReport.contextData) {
            for key in sessionContextKeys {
                if let value = sessionContext[key] {
                    json[key] = value
                }
            }
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

    private static func sanitizeSessionContext(_ context: [String: Any]) -> [String: Any] {
        var sanitized: [String: Any] = [:]

        if let sessionId = nonEmptyString(context["sessionId"]) {
            sanitized["sessionId"] = sessionId
        }
        // Android uses activatedAt to map a crash to persisted session history.
        // iOS keeps it in the shared context shape, although PLCrashReporter
        // already snapshots the one active context directly into the report.
        if let activatedAt = context["activatedAt"] as? NSNumber,
           activatedAt.doubleValue.isFinite,
           activatedAt.doubleValue > 0 {
            sanitized["activatedAt"] = activatedAt
        }
        if let isSampled = context["isSampled"] as? NSNumber {
            sanitized["isSampled"] = isSampled.boolValue
        }
        for key in ["appVersion", "appRelease", "appBundleId"] {
            if let value = nonEmptyString(context[key]) {
                sanitized[key] = value
            }
        }

        return sanitized
    }

    private static func decodeSessionContext(_ data: Data?) -> [String: Any]? {
        guard let data else {
            return nil
        }
        do {
            guard let context = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  nonEmptyString(context["sessionId"]) != nil else {
                return nil
            }
            return sanitizeSessionContext(context)
        } catch {
            print("[FaroCrashReporter] Failed to decode crash session context: \(error)")
            return nil
        }
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String else {
            return nil
        }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func malformedReportJSON(reportId: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: ["reportId": reportId])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{\"reportId\":\"\(reportId)\"}"
    }

    private static func reportIdentifier(from crashReportJSON: String) -> String? {
        guard let data = crashReportJSON.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return nonEmptyString(json["reportId"])
    }

    private static func reportIdentifier(for data: Data) -> String {
        // PLCrashReporter stores a single immutable report. A deterministic hash
        // gives both retrieval and acknowledgement the same stable opaque ID,
        // including when the report itself cannot be parsed.
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in data {
            hash ^= UInt64(byte)
            hash = hash &* 1_099_511_628_211
        }
        let hex = String(hash, radix: 16)
        return "ios-\(String(repeating: "0", count: max(0, 16 - hex.count)))\(hex)"
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
