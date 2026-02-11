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
    
    /// Count of slow frames since last reset
    @objc public private(set) var slowFrameCount: Int = 0
    
    /// Count of frozen frames since last reset
    @objc public private(set) var frozenFrameCount: Int = 0
    
    /// Whether monitoring is active
    @objc public private(set) var isMonitoring: Bool = false
    
    /// Shared instance for global access
    @objc public static let shared = RefreshRateVitals()
    
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
        slowFrameCount = 0
        frozenFrameCount = 0
        lastFrameTimestamp = nil
        nextFrameDuration = nil
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
    
    /// Get and reset slow frame count
    @objc public func getAndResetSlowFrames() -> Int {
        let count = slowFrameCount
        slowFrameCount = 0
        return count
    }
    
    /// Get and reset frozen frame count
    @objc public func getAndResetFrozenFrames() -> Int {
        let count = frozenFrameCount
        frozenFrameCount = 0
        return count
    }
    
    // MARK: - Private Methods
    
    @objc private func displayTick(link: CADisplayLink) {
        guard let fps = calculateFPS(provider: link) else { return }
        
        lastRefreshRate = fps
        
        // Check for slow frames (below target FPS)
        if fps < targetFps {
            slowFrameCount += 1
        }
        
        // Check for frozen frames (frame duration exceeds threshold)
        if let lastTimestamp = lastFrameTimestamp {
            let frameDuration = link.timestamp - lastTimestamp
            if frameDuration > frozenFrameThreshold {
                frozenFrameCount += 1
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
