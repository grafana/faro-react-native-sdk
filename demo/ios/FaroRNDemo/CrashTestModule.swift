import Foundation

/**
 * Demo-only native module for testing crash reporting on iOS.
 *
 * This module is NOT part of the Faro SDK - it exists only in the demo app
 * to allow triggering test crashes for demonstration purposes.
 *
 * WARNING: Do not include this in production apps!
 */
@objc(CrashTestModule)
class CrashTestModule: NSObject {

    /**
     * Trigger a test crash.
     *
     * This method triggers a fatal error that will crash the app.
     * The crash will be captured by PLCrashReporter and reported on
     * next app launch via Faro's CrashReportingInstrumentation.
     *
     * WARNING: This will immediately terminate the app!
     */
    @objc
    func triggerTestCrash() {
        // Use fatalError for a clean crash that PLCrashReporter can capture
        // This generates a SIGABRT signal
        fatalError("Faro Test Crash: This is an intentional crash for testing crash reporting")
    }

    /**
     * Trigger an ANR-like freeze by blocking the main thread.
     *
     * iOS doesn't have an official ANR mechanism like Android, but blocking
     * the main thread will make the app unresponsive. The system may terminate
     * the app if it remains unresponsive for too long (watchdog termination).
     *
     * WARNING: This will freeze the app for 10 seconds!
     */
    @objc
    func triggerANR() {
        // Block main thread for 10 seconds
        // This simulates an ANR-like condition
        Thread.sleep(forTimeInterval: 10.0)
    }

    /**
     * Required by React Native for native modules.
     * Indicates this module should be initialized on the main queue.
     */
    @objc
    static func requiresMainQueueSetup() -> Bool {
        return false
    }
}
