import UIKit
import XCTest

private final class TrackingNotificationCenter: NotificationCenter, @unchecked Sendable {
    var registrations = Set<Notification.Name>()
    override func addObserver(_ observer: Any, selector: Selector, name: Notification.Name?, object: Any?) {
        if let name { registrations.insert(name) }
        super.addObserver(observer, selector: selector, name: name, object: object)
    }
    override func removeObserver(_ observer: Any, name: Notification.Name?, object: Any?) {
        if let name { registrations.remove(name) }
        super.removeObserver(observer, name: name, object: object)
    }
}

final class RefreshRateVitalsTests: XCTestCase {
    @objc private func unusedDisplayTick(_ link: CADisplayLink) {}

    private func withMonitor(active: Bool = true, _ test: (RefreshRateVitals, NotificationCenter) -> Void) {
        let center = NotificationCenter()
        let monitor = RefreshRateVitals(notificationCenter: center, isApplicationActive: { active })
        defer { monitor.stop() }
        monitor.start()
        test(monitor, center)
    }

    private func tick(_ monitor: RefreshRateVitals, _ time: Double, hz: Int = 60) {
        monitor.recordFrame(timestamp: time, targetTimestamp: time + 1.0 / Double(hz), maximumFramesPerSecond: hz)
    }

    func testBackgroundGapIsNotAFrozenFrame() {
        let center = NotificationCenter()
        let monitor = RefreshRateVitals(notificationCenter: center, isApplicationActive: { true })
        defer { monitor.stop() }
        monitor.start()
        monitor.recordFrame(timestamp: 1, targetTimestamp: 1.016, maximumFramesPerSecond: 60)
        center.post(name: UIApplication.willResignActiveNotification, object: nil)
        center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        monitor.recordFrame(timestamp: 61, targetTimestamp: 61.016, maximumFramesPerSecond: 60)
        XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
    }

    func testActiveStallsAreStillCountedAndDrainedOnce() {
        withMonitor { monitor, _ in
            tick(monitor, 1)
            tick(monitor, 2)
            tick(monitor, 3.5)
            let metrics = monitor.getAndResetFrozenMetrics()
            XCTAssertEqual(metrics["count"], 2)
            XCTAssertEqual(metrics["durationMs"], 2500)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["durationMs"], 0)
        }
    }

    func testInactiveTicksAreIgnored() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
            tick(monitor, 10)
            tick(monitor, 20)
            XCTAssertTrue(monitor.isMonitoring)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 30)
            tick(monitor, 30.01)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
        }
    }

    func testStartWhileInactiveWaitsForActivation() {
        withMonitor(active: false) { monitor, center in
            tick(monitor, 1)
            tick(monitor, 20)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 30)
            tick(monitor, 31)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 1)
        }
    }

    func testIncompleteSlowEpisodeDoesNotCrossInactivePeriod() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            tick(monitor, 1.03)
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 10)
            tick(monitor, 10.01)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
        }
    }

    func testPauseDoesNotCompleteAnOpenSlowEpisode() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            tick(monitor, 1.016667)
            tick(monitor, 1.033334)
            tick(monitor, 1.050001)
            tick(monitor, 1.066668)
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
            center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 20)
            tick(monitor, 20.01)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
        }
    }

    func testCompletedMetricsSurvivePauseAndResume() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            tick(monitor, 2)
            tick(monitor, 2.1)
            tick(monitor, 2.11)
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
            center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 100)
            tick(monitor, 100.01)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 1)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["durationMs"], 1000)
        }
    }

    func testStopWhileInactiveDoesNotResumeOnNotification() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            center.post(name: UIApplication.willResignActiveNotification, object: nil)
            monitor.stop()
            monitor.stop()
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 100)
            tick(monitor, 101)
            XCTAssertFalse(monitor.isMonitoring)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
        }
    }

    func testRepeatedStartDoesNotResetActiveSamples() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            monitor.start()
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 2)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 1)
        }
    }

    func testRepeatedLifecycleCyclesRecoverAndCountRealStalls() {
        withMonitor { monitor, center in
            for cycle in 0..<20 {
                let time = Double(cycle * 100)
                tick(monitor, time)
                center.post(name: UIApplication.willResignActiveNotification, object: nil)
                center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
                tick(monitor, time + 40)
                center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
                tick(monitor, time + 50)
                tick(monitor, time + 51)
                XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 1)
                monitor.stop()
                monitor.start()
            }
        }
    }

    func testBackgroundNotificationAloneResetsBaseline() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            tick(monitor, 100)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
        }
    }

    func testDuplicateInactiveNotificationsDoNotClearCompletedMetrics() {
        withMonitor { monitor, center in
            tick(monitor, 1)
            tick(monitor, 2)
            for _ in 0..<3 {
                center.post(name: UIApplication.willResignActiveNotification, object: nil)
                center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            }
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 1)
        }
    }

    func testRestartDropsPreviousTimingAndPendingSlowEpisode() {
        withMonitor { monitor, _ in
            tick(monitor, 1)
            tick(monitor, 1.1)
            monitor.stop()
            monitor.start()
            tick(monitor, 100)
            tick(monitor, 100.01)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
            XCTAssertEqual(monitor.getAndResetSlowFrames(), 0)
        }
    }

    func testCustomThresholdIsStrictlyGreaterThan() {
        withMonitor { monitor, _ in
            monitor.configure(targetFps: 60, frozenFrameThresholdMs: 500, normalizedRefreshRate: 60)
            tick(monitor, 1)
            tick(monitor, 1.5)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
            tick(monitor, 2.01)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 1)
        }
    }

    func testPromotionNormalizationIsUnchanged() {
        withMonitor { monitor, _ in
            tick(monitor, 1, hz: 120)
            tick(monitor, 1 + 1.0 / 120, hz: 120)
            XCTAssertEqual(monitor.getRefreshRate(), 60, accuracy: 0.001)
        }
    }

    func testStopDetachesNotificationsAndDisplayLink() {
        let center = NotificationCenter()
        weak var released: RefreshRateVitals?
        autoreleasepool {
            let monitor = RefreshRateVitals(notificationCenter: center, isApplicationActive: { true })
            released = monitor
            monitor.start()
            monitor.stop()
        }
        XCTAssertNil(released)
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func testCallbackFromAnotherDisplayLinkCannotSeedTiming() {
        withMonitor { monitor, _ in
            let stale = CADisplayLink(target: self, selector: #selector(unusedDisplayTick(_:)))
            defer { stale.invalidate() }
            let callback = NSSelectorFromString("displayTickWithLink:")
            XCTAssertTrue(monitor.responds(to: callback))
            monitor.perform(callback, with: stale)
            tick(monitor, 100)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
        }
    }

    func testSubThresholdActiveIntervalsDoNotBecomeFrozenFrames() {
        withMonitor { monitor, _ in
            tick(monitor, 1)
            tick(monitor, 1.5)
            tick(monitor, 2.1)
            XCTAssertEqual(monitor.getAndResetFrozenMetrics()["count"], 0)
        }
    }

    func testStopRemovesEveryLifecycleSubscription() {
        let center = TrackingNotificationCenter()
        let monitor = RefreshRateVitals(notificationCenter: center, isApplicationActive: { true })
        defer { monitor.stop() }
        for _ in 0..<3 {
            monitor.start()
            XCTAssertEqual(center.registrations, [UIApplication.willResignActiveNotification,
                                                  UIApplication.didEnterBackgroundNotification,
                                                  UIApplication.didBecomeActiveNotification])
            monitor.stop()
            XCTAssertTrue(center.registrations.isEmpty)
        }
    }
}
