import Foundation
import Darwin

/// Task-level cumulative CPU includes threads that exited during a window.
@objc public class CPUInfo: NSObject {
    @objc public static func getCpuTimeMs() -> NSNumber? {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return nil }
        let user = Double(usage.ru_utime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec) / 1000
        let system = Double(usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_stime.tv_usec) / 1000
        return NSNumber(value: user + system)
    }
}
