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
     * Trigger a main thread freeze using a busy-wait loop.
     *
     * This keeps the main thread busy with computation, which allows
     * CADisplayLink callbacks to run but with extremely delayed timing.
     * The delays will be detected as frozen frames.
     *
     * WARNING: This will freeze the app for 3 seconds!
     */
    @objc
    func triggerFreeze() {
        // Ensure we're on the main thread
        if Thread.isMainThread {
            self.blockMainThreadWithBusyLoop()
        } else {
            DispatchQueue.main.async {
                self.blockMainThreadWithBusyLoop()
            }
        }
    }
    
    /// Blocks the main thread with a CPU-intensive busy loop
    private func blockMainThreadWithBusyLoop() {
        let endTime = Date().addingTimeInterval(3.0)
        var counter: UInt64 = 0
        
        // Tight busy loop - keeps main thread occupied
        // CADisplayLink will try to fire but will be severely delayed
        while Date() < endTime {
            counter = counter &+ 1
            // Every 100 million iterations, do a tiny bit of work
            // This creates frame gaps that CADisplayLink will detect
            if counter % 100_000_000 == 0 {
                // This slight delay accumulates and creates detectable frame drops
                usleep(50_000) // 50ms delay
            }
        }
    }
    
    /**
     * Trigger slow frames by doing moderate CPU work on the main thread.
     *
     * Creates janky animations by periodically blocking the main thread
     * for 20-30ms, causing frames to drop below 60 FPS.
     *
     * WARNING: This will cause janky UI for 5 seconds!
     */
    @objc
    func triggerSlowFrames() {
        DispatchQueue.main.async {
            let endTime = Date().addingTimeInterval(5.0)
            var iteration = 0
            
            while Date() < endTime {
                // Do work that takes ~20-30ms per iteration
                // This causes frames to render slower than 60fps
                var sum = 0.0
                for i in 0..<500_000 {
                    sum += Double(i)
                }
                
                // Small sleep to allow some frames to render (but slowly)
                usleep(20_000) // 20ms = ~50fps (slow but not frozen)
                
                iteration += 1
                
                // Every 20 iterations, give the UI a brief break
                if iteration % 20 == 0 {
                    usleep(5_000) // 5ms break
                }
            }
        }
    }
    
    /**
     * Trigger heavy load with mixed slow frames and occasional freezes.
     *
     * Simulates a worst-case scenario with continuous poor performance.
     * Combines slow frame rendering with periodic freezes.
     *
     * WARNING: This will cause severe performance issues for 10 seconds!
     */
    @objc
    func triggerHeavyLoad() {
        DispatchQueue.main.async {
            let endTime = Date().addingTimeInterval(10.0)
            var iteration = 0
            
            while Date() < endTime {
                // Most iterations: slow frames (20-30ms work)
                var sum = 0.0
                for i in 0..<500_000 {
                    sum += Double(i)
                }
                usleep(20_000) // 20ms = slow frame
                
                iteration += 1
                
                // Every 10th iteration: brief freeze (150ms)
                if iteration % 10 == 0 {
                    usleep(150_000) // 150ms = frozen frame
                }
            }
        }
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
