import Foundation
import UIKit

/// Provides frame rate and refresh rate monitoring using CADisplayLink.
///
/// Implementation ported from Faro Flutter SDK:
/// https://github.com/grafana/faro-flutter-sdk/blob/main/ios/Classes/RefreshRateVitals.swift
///
/// Uses CADisplayLink to measure actual frame durations and calculate FPS.
/// Handles ProMotion displays (120Hz) by normalizing to 60 FPS baseline.
@objc public class RefreshRateVitals: NSObject {
    private var displayLink: CADisplayLink?
    private var lastFrameTimestamp: CFTimeInterval?
    private var nextFrameDuration: CFTimeInterval?
    
    /// Normalized refresh rate for backend compatibility (default 60 FPS)
    private var normalizedRefreshRate: Double = 60.0
    
    /// Target FPS for slow frame detection
    private var targetFps: Double = 60.0
    
    /// Threshold in seconds for frozen frame detection
    private var frozenFrameThreshold: Double = 0.100
    
    /// Last calculated refresh rate
    @objc public private(set) var lastRefreshRate: Double = 0.0
    
    /// Count of slow frame events since last reset (not individual frames)
    @objc public private(set) var slowFrameEventCount: Int = 0
    
    /// Count of frozen frames since last reset
    @objc public private(set) var frozenFrameCount: Int = 0
    
    /// Total duration of frozen frames in milliseconds
    @objc public private(set) var frozenFrameDurationMs: Double = 0
    
    /// Whether monitoring is active
    @objc public private(set) var isMonitoring: Bool = false
    
    /// Shared instance for global access
    @objc public static let shared = RefreshRateVitals()
    
    // MARK: - Slow Frame Event Detection
    
    /// Whether we're currently in a slow frame event
    private var inSlowFrameEvent: Bool = false
    
    /// Timestamp when current slow frame event started
    private var slowFrameEventStartTime: CFTimeInterval = 0
    
    /// Minimum duration (in seconds) for a slow frame event to be counted (prevents noise)
    private let slowFrameEventMinDuration: Double = 0.050  // ~3 frames at 60fps
    
    private override init() {
        super.init()
    }
    
    // MARK: - Public Methods
    
    /// Configure monitoring parameters
    /// - Parameters:
    ///   - targetFps: Target FPS for slow frame detection (default 60)
    ///   - frozenFrameThresholdMs: Threshold in ms for frozen frames (default 100)
    ///   - normalizedRefreshRate: Normalized rate for ProMotion displays (default 60)
    @objc public func configure(
        targetFps: Double,
        frozenFrameThresholdMs: Double,
        normalizedRefreshRate: Double
    ) {
        self.targetFps = targetFps
        self.frozenFrameThreshold = frozenFrameThresholdMs / 1000.0
        self.normalizedRefreshRate = normalizedRefreshRate
    }
    
    /// Start frame monitoring
    @objc public func start() {
        guard !isMonitoring else { return }
        
        displayLink = CADisplayLink(target: self, selector: #selector(displayTick(link:)))
        displayLink?.add(to: .main, forMode: .common)
        isMonitoring = true
        
        // Reset counters
        slowFrameEventCount = 0
        frozenFrameCount = 0
        frozenFrameDurationMs = 0
        lastFrameTimestamp = nil
        nextFrameDuration = nil
        inSlowFrameEvent = false
        slowFrameEventStartTime = 0
    }
    
    /// Stop frame monitoring
    @objc public func stop() {
        displayLink?.invalidate()
        displayLink = nil
        lastFrameTimestamp = nil
        nextFrameDuration = nil
        isMonitoring = false
    }
    
    /// Get current refresh rate
    @objc public func getRefreshRate() -> Double {
        return lastRefreshRate
    }
    
    /// Get and reset slow frame event count
    @objc public func getAndResetSlowFrames() -> Int {
        let count = slowFrameEventCount
        slowFrameEventCount = 0
        return count
    }
    
    /// Get and reset frozen frame count
    @objc public func getAndResetFrozenFrames() -> Int {
        let count = frozenFrameCount
        frozenFrameCount = 0
        return count
    }
    
    /// Get and reset frozen frame duration in milliseconds
    @objc public func getAndResetFrozenDuration() -> Double {
        let duration = frozenFrameDurationMs
        frozenFrameDurationMs = 0
        return duration
    }
    
    // MARK: - Private Methods
    
    @objc private func displayTick(link: CADisplayLink) {
        // Check for frozen frames FIRST (before calculateFPS updates lastFrameTimestamp)
        if let lastTimestamp = lastFrameTimestamp {
            let frameDuration = link.timestamp - lastTimestamp
            if frameDuration > frozenFrameThreshold {
                frozenFrameCount += 1
                
                // Track duration in milliseconds
                let durationMs = frameDuration * 1000
                frozenFrameDurationMs += durationMs
                
                NSLog("[Faro] Frozen frame detected! Duration: %.0fms (threshold: %.0fms)", durationMs, frozenFrameThreshold * 1000)
            }
        }
        
        guard let fps = calculateFPS(provider: link) else { return }
        
        lastRefreshRate = fps
        
        // Check for slow frames using event-based detection
        // A slow frame "event" is a period of consecutive frames below target FPS
        // This groups consecutive slow frames to report meaningful jank, not microsecond variations
        let isSlow = fps < targetFps
        
        // 🔍 TEMP DEBUG LOG - Remove after analysis
        if isSlow {
            NSLog("[Faro DEBUG IOS] 🐌 Slow frame detected: %.1f FPS (target: %.1f)", fps, targetFps)
        }
        
        if isSlow {
            if !inSlowFrameEvent {
                // Start new slow frame event
                inSlowFrameEvent = true
                slowFrameEventStartTime = link.timestamp
            }
        } else {
            // Frame is good - check if we should end the current slow frame event
            if inSlowFrameEvent {
                let eventDuration = link.timestamp - slowFrameEventStartTime
                let eventDurationMs = eventDuration * 1000
                
                // Only count as a slow frame event if it lasted long enough to be user-perceptible
                // This filters out single-frame dips that don't affect user experience
                if eventDuration >= slowFrameEventMinDuration {
                    slowFrameEventCount += 1
                    // 🔍 TEMP DEBUG LOG - Remove after analysis
                    NSLog("[Faro DEBUG IOS] ✅ COUNTED as event (%.0fms)! Total events now: %d", eventDurationMs, slowFrameEventCount)
                } else {
                    // 🔍 TEMP DEBUG LOG - Remove after analysis
                    NSLog("[Faro DEBUG IOS] ❌ NOT counted (%.0fms is too short). Total events still: %d", eventDurationMs, slowFrameEventCount)
                }
                
                inSlowFrameEvent = false
                slowFrameEventStartTime = 0
            }
        }
    }
    
    /// Calculate frames per second from display link timing
    private func calculateFPS(provider: CADisplayLink) -> Double? {
        guard let lastTimestamp = lastFrameTimestamp else {
            // First frame - just record timestamp
            lastFrameTimestamp = provider.timestamp
            nextFrameDuration = provider.targetTimestamp - provider.timestamp
            return nil
        }
        
        let currentFrameDuration = provider.timestamp - lastTimestamp
        guard currentFrameDuration > 0 else { return nil }
        
        let currentFPS = 1.0 / currentFrameDuration
        var fps: Double
        
        // ProMotion displays can have refresh rates higher than 60 FPS
        // Normalize to backend-supported rate for consistent metrics
        if let expectedFrameDuration = nextFrameDuration,
           expectedFrameDuration > 0,
           UIScreen.main.maximumFramesPerSecond > 60 {
            let expectedFPS = 1.0 / expectedFrameDuration
            fps = currentFPS * (normalizedRefreshRate / expectedFPS)
        } else {
            fps = currentFPS
        }
        
        // Update timestamps for next frame
        lastFrameTimestamp = provider.timestamp
        nextFrameDuration = provider.targetTimestamp - provider.timestamp
        
        return fps
    }
}
