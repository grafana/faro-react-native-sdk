import CrashReporter
import Foundation

/// Intermediate representation of a crash report from PLCrashReporter.
///
/// This struct provides a simplified, serializable model of crash data that can be
/// converted to JSON and sent to the Faro collector. The design follows the Flutter
/// SDK's pattern for consistency across mobile platforms.
///
/// ## Data Flow
/// ```
/// PLCrashReport (PLCrashReporter) → FaroCrashReport (this struct) → JSON → Faro Collector
/// ```
internal struct FaroCrashReport {
    /// A client-generated 16-byte UUID of the incident.
    var incidentIdentifier: String?
    /// System information from the moment of crash.
    var systemInfo: FaroSystemInfo?
    /// Information about the process that crashed.
    var processInfo: FaroCrashedProcessInfo?
    /// Information about the fatal signal.
    var signalInfo: FaroSignalInfo?
    /// Uncaught exception information. Only available if a crash was caused by an uncaught exception.
    var exceptionInfo: FaroExceptionInfo?
    /// Information about all threads running at the moment of crash.
    var threads: [FaroThreadInfo]
    /// Information about binary images loaded by the process.
    var binaryImages: [FaroBinaryImageInfo]
    /// Custom user data injected before the crash occurred.
    var contextData: Data?
    /// Flag indicating if any stack traces were truncated due to size limits.
    var wasTruncated: Bool
}

/// System information at the time of crash.
internal struct FaroSystemInfo {
    /// Date and time when the crash report was generated.
    var timestamp: Date?
}

/// Information about the crashed process.
internal struct FaroCrashedProcessInfo {
    /// The name of the process.
    var processName: String?
    /// The process ID.
    var processID: UInt
    /// The path to the process executable.
    var processPath: String?
    /// The parent process ID.
    var parentProcessID: UInt
    /// The parent process name.
    var parentProcessName: String?
}

/// Information about the fatal signal that caused the crash.
internal struct FaroSignalInfo {
    /// The name of the BSD termination signal, e.g., `SIGTRAP`, `SIGSEGV`.
    var name: String?
    /// Termination signal code, e.g., `#0`.
    var code: String?
    /// The faulting instruction address.
    var address: UInt64
}

/// Information about an uncaught exception (if the crash was caused by one).
internal struct FaroExceptionInfo {
    /// The exception name, e.g., `NSInternalInconsistencyException`.
    var name: String?
    /// The exception reason, e.g., `unable to dequeue a cell with identifier foo`.
    var reason: String?
    /// The stack trace of this exception.
    var stackFrames: [FaroStackFrame]
}

/// Information about a thread at the time of crash.
internal struct FaroThreadInfo {
    /// Application thread number.
    var threadNumber: Int
    /// Whether this thread crashed.
    var crashed: Bool
    /// The stack trace of this thread.
    var stackFrames: [FaroStackFrame]
}

/// Information about a binary image loaded by the process.
internal struct FaroBinaryImageInfo {
    internal struct CodeType {
        /// The name of CPU architecture, e.g., `arm64`, `x86_64`.
        var architectureName: String?
    }

    /// The UUID of this image.
    var uuid: String?
    /// The name of this image.
    var imageName: String
    /// Whether this is a system library image.
    var isSystemImage: Bool
    /// Image code type (architecture information).
    var codeType: CodeType?
    /// The load address of this image.
    var imageBaseAddress: UInt64
    /// The size of this image segment.
    var imageSize: UInt64
}

/// A single frame in a stack trace.
internal struct FaroStackFrame: Codable {
    /// The number of this frame in the stack trace.
    var number: Int
    /// The name of the library that produced this frame.
    var libraryName: String?
    /// The load address of the library that produced this frame.
    var libraryBaseAddress: UInt64?
    /// The instruction pointer of this frame.
    var instructionPointer: UInt64

    /// Converts to a dictionary suitable for JSON serialization.
    var jsonRepresentation: [String: Any] {
        return [
            "lineno": number,
            "colno": 0,
            "filename": libraryName ?? "",
            "function": "\(libraryBaseAddress ?? 0) \(instructionPointer)"
        ]
    }
}

// MARK: - FaroCrashReport Exception

internal struct FaroCrashReportException: Error {
    let description: String
}

// MARK: - PLCrashReporter Extensions

extension FaroCrashReport {
    /// Creates a FaroCrashReport from a PLCrashReport.
    init(from plcr: PLCrashReport) throws {
        guard let threads = plcr.threads,
              let images = plcr.images else {
            throw FaroCrashReportException(
                description: "Received inconsistent PLCrashReport: threads=\(plcr.threads != nil), images=\(plcr.images != nil)"
            )
        }

        if let uuid = plcr.uuidRef, let uuidString = CFUUIDCreateString(nil, uuid) {
            self.incidentIdentifier = uuidString as String
        } else {
            self.incidentIdentifier = nil
        }

        self.systemInfo = FaroSystemInfo(from: plcr)
        self.processInfo = FaroCrashedProcessInfo(from: plcr)
        self.signalInfo = FaroSignalInfo(from: plcr)
        self.exceptionInfo = FaroExceptionInfo(from: plcr)

        self.threads = threads
            .compactMap { $0 as? PLCrashReportThreadInfo }
            .map { FaroThreadInfo(from: $0, in: plcr) }

        self.binaryImages = images
            .compactMap { $0 as? PLCrashReportBinaryImageInfo }
            .compactMap { FaroBinaryImageInfo(from: $0) }

        self.contextData = plcr.customData
        self.wasTruncated = false
    }
}

extension FaroSystemInfo {
    init?(from plcr: PLCrashReport) {
        guard let systemInfo = plcr.systemInfo else {
            return nil
        }
        self.timestamp = systemInfo.timestamp
    }
}

extension FaroCrashedProcessInfo {
    init?(from plcr: PLCrashReport) {
        guard plcr.hasProcessInfo, let processInfo = plcr.processInfo else {
            return nil
        }
        self.processName = processInfo.processName
        self.processID = processInfo.processID
        self.processPath = processInfo.processPath
        self.parentProcessID = processInfo.parentProcessID
        self.parentProcessName = processInfo.parentProcessName
    }
}

extension FaroSignalInfo {
    init?(from plcr: PLCrashReport) {
        guard let signalInfo = plcr.signalInfo else {
            return nil
        }
        self.name = signalInfo.name
        self.code = signalInfo.code
        self.address = signalInfo.address
    }
}

extension FaroExceptionInfo {
    init?(from plcr: PLCrashReport) {
        guard plcr.hasExceptionInfo, let exceptionInfo = plcr.exceptionInfo else {
            return nil
        }
        self.name = exceptionInfo.exceptionName
        self.reason = exceptionInfo.exceptionReason

        if let stackFrames = exceptionInfo.stackFrames {
            self.stackFrames = stackFrames
                .compactMap { $0 as? PLCrashReportStackFrameInfo }
                .enumerated()
                .map { number, frame in FaroStackFrame(from: frame, number: number, in: plcr) }
        } else {
            self.stackFrames = []
        }
    }
}

extension FaroThreadInfo {
    init(from threadInfo: PLCrashReportThreadInfo, in crashReport: PLCrashReport) {
        self.threadNumber = threadInfo.threadNumber
        self.crashed = threadInfo.crashed

        if let stackFrames = threadInfo.stackFrames {
            self.stackFrames = stackFrames
                .compactMap { $0 as? PLCrashReportStackFrameInfo }
                .enumerated()
                .map { number, frame in FaroStackFrame(from: frame, number: number, in: crashReport) }
        } else {
            self.stackFrames = []
        }
    }
}

extension FaroBinaryImageInfo {
    init?(from imageInfo: PLCrashReportBinaryImageInfo) {
        guard let imagePath = imageInfo.imageName else {
            return nil
        }

        self.uuid = imageInfo.imageUUID
        self.imageName = URL(fileURLWithPath: imagePath).lastPathComponent

        #if targetEnvironment(simulator)
        self.isSystemImage = Self.isPathSystemImageInSimulator(imagePath)
        #else
        self.isSystemImage = Self.isPathSystemImageInDevice(imagePath)
        #endif

        if let codeType = imageInfo.codeType {
            self.codeType = CodeType(from: codeType)
        } else {
            self.codeType = nil
        }

        self.imageBaseAddress = imageInfo.imageBaseAddress
        self.imageSize = imageInfo.imageSize
    }

    static func isPathSystemImageInSimulator(_ path: String) -> Bool {
        return path.contains("/Contents/Developer/Platforms/")
    }

    static func isPathSystemImageInDevice(_ path: String) -> Bool {
        let isUserImage = path.contains("/Bundle/Application/")
        return !isUserImage
    }
}

extension FaroBinaryImageInfo.CodeType {
    init?(from processorInfo: PLCrashReportProcessorInfo) {
        guard processorInfo.typeEncoding == PLCrashReportProcessorTypeEncodingMach else {
            return nil
        }

        let type = processorInfo.type
        let subtype = processorInfo.subtype
        let subtypeMask = UInt64(CPU_SUBTYPE_MASK)

        switch type {
        case UInt64(CPU_TYPE_X86):
            self.architectureName = "i386"
        case UInt64(CPU_TYPE_X86_64):
            self.architectureName = "x86_64"
        case UInt64(CPU_TYPE_ARM):
            self.architectureName = "arm"
        case UInt64(CPU_TYPE_ARM64):
            switch subtype & ~subtypeMask {
            case UInt64(CPU_SUBTYPE_ARM64_ALL):
                self.architectureName = "arm64"
            case UInt64(CPU_SUBTYPE_ARM64_V8):
                self.architectureName = "armv8"
            case UInt64(CPU_SUBTYPE_ARM64E):
                self.architectureName = "arm64e"
            default:
                self.architectureName = "arm64-unknown"
            }
        default:
            self.architectureName = nil
        }
    }
}

extension FaroStackFrame {
    init(from stackFrame: PLCrashReportStackFrameInfo, number: Int, in crashReport: PLCrashReport) {
        self.number = number
        self.instructionPointer = stackFrame.instructionPointer

        let image = crashReport.image(forAddress: stackFrame.instructionPointer)
        self.libraryBaseAddress = image?.imageBaseAddress

        if let imagePath = image?.imageName {
            self.libraryName = URL(fileURLWithPath: imagePath).lastPathComponent
        }
    }
}
