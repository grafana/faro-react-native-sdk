import CoreTelephony
import Foundation
import Network
import UIKit

/// Device and network values that change while the app runs.
///
/// Notifications and a path monitor update a lock-protected cache, so `current()` is safe to call
/// from any thread and reads nothing from the system. The one exception is internet reachability:
/// iOS has no equivalent of Android's validated-network flag, so a small background request to the
/// endpoint Android uses for that check fills the cache. Nothing here needs a permission, and every
/// value is omitted when it cannot be read. iOS never reports a carrier: Apple deprecated the API,
/// and since iOS 16.4 it returns a placeholder.
///
/// Ported from the Faro Flutter SDK's `DynamicDeviceState`.
@objc public final class FaroDynamicDeviceState: NSObject {
    static let batteryLevelKey = "batteryLevel"
    static let isChargingKey = "isCharging"
    static let lowPowerModeKey = "lowPowerMode"
    static let thermalStateKey = "thermalState"
    static let connectionTypeKey = "connectionType"
    static let connectionSubtypeKey = "connectionSubtype"
    static let reachableKey = "reachable"
    /// True while the connection state is still being worked out: the path monitor has not reported
    /// yet, or the reachability probe has not answered. JavaScript then re-reads soon, so it does not
    /// keep an incomplete state for its whole cache time.
    static let reachabilityPendingKey = "reachabilityPending"

    private static let lock = NSLock()
    private static var started = false
    private static var observers: [NSObjectProtocol] = []
    private static var pathMonitor: NWPathMonitor?
    private static var latestPath: NWPath?
    private static var cachedBatteryLevel: Int?
    private static var cachedIsCharging: Bool?
    private static var cachedLowPowerMode: Bool?
    private static var cachedThermalState: String?
    private static var cachedRadioTechnologies: [String] = []
    private static let telephonyInfo = CTTelephonyNetworkInfo()

    // The endpoint Android uses to validate a network, over HTTPS to satisfy App Transport Security.
    // It answers 204 with no body, which a captive portal cannot fake over HTTPS.
    private static let reachabilityProbeURL = URL(string: "https://connectivitycheck.gstatic.com/generate_204")!
    private static let reachabilityProbeTimeout: TimeInterval = 3
    private static let reachabilityRecheckInterval: TimeInterval = 30
    private static let reachabilityRetryInterval: TimeInterval = 10
    private static var probedReachability: Bool?
    private static var probeGeneration = 0
    private static var probeInFlight = false
    private static var lastProbeStartedAt: Date?
    private static let probeSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = reachabilityProbeTimeout
        // The request timeout only limits idle time, so this caps the whole probe.
        configuration.timeoutIntervalForResource = reachabilityProbeTimeout
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    /// Starts battery and network monitoring and seeds the cache. Safe to call more than once.
    /// UIDevice battery monitoring is main-thread-only, so call it on the main thread, early.
    @MainActor @objc public static func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else {
            return
        }
        started = true

        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        readBattery(device)
        let center = NotificationCenter.default
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: nil) { _ in
                    lock.lock()
                    defer { lock.unlock() }
                    readBattery(UIDevice.current)
                }
            )
        }

        let processInfo = ProcessInfo.processInfo
        cachedLowPowerMode = processInfo.isLowPowerModeEnabled
        cachedThermalState = thermalStateName(processInfo.thermalState)
        cachedRadioTechnologies = currentRadioTechnologies()
        observers.append(
            center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { _ in
                lock.lock()
                defer { lock.unlock() }
                cachedLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
        )
        observers.append(
            center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { _ in
                lock.lock()
                defer { lock.unlock() }
                cachedThermalState = thermalStateName(ProcessInfo.processInfo.thermalState)
            }
        )
        observers.append(
            center.addObserver(
                forName: .CTServiceRadioAccessTechnologyDidChange, object: nil, queue: nil
            ) { _ in
                let technologies = currentRadioTechnologies()
                lock.lock()
                defer { lock.unlock() }
                cachedRadioTechnologies = technologies
            }
        )

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            lock.lock()
            latestPath = path
            // A result for the previous network says nothing about this one.
            probeGeneration += 1
            probedReachability = nil
            lock.unlock()
            probeReachability(force: true)
        }
        monitor.start(queue: DispatchQueue(label: "com.grafana.faro.network-path", qos: .utility))
        pathMonitor = monitor
    }

    /// The cached values. Empty until `start()` has run.
    @objc public static func current() -> [String: Any] {
        lock.lock()
        let level = cachedBatteryLevel
        let charging = cachedIsCharging
        let path = latestPath
        let probedReachability = probedReachability
        let lowPowerMode = cachedLowPowerMode
        let thermalState = cachedThermalState
        let radioTechnologies = cachedRadioTechnologies
        lock.unlock()

        var state: [String: Any] = [:]
        if let level {
            state[batteryLevelKey] = level
        }
        if let charging {
            state[isChargingKey] = charging
        }
        if let lowPowerMode {
            state[lowPowerModeKey] = lowPowerMode
        }
        if let thermalState {
            state[thermalStateKey] = thermalState
        }

        if let path {
            let type = connectionType(
                status: path.status,
                interfaceType: path.availableInterfaces.first?.type
            )
            state[connectionTypeKey] = type
            // NWPath only says whether a route exists, so a satisfied path waits for the probe.
            if path.status != .satisfied {
                state[reachableKey] = false
            } else if let probedReachability {
                state[reachableKey] = probedReachability
            } else {
                state[reachabilityPendingKey] = true
            }
            if type == "cell" {
                if let subtype = connectionSubtypeName(radioTechnologies: radioTechnologies) {
                    state[connectionSubtypeKey] = subtype
                }
            }
        } else {
            // The path monitor has not reported yet.
            state[reachabilityPendingKey] = true
        }
        probeReachability(force: false)
        return state
    }

    /// Starts a probe in the background unless one is running or the last result is recent. Never waits.
    private static func probeReachability(force: Bool) {
        lock.lock()
        guard let path = latestPath, path.status == .satisfied, !probeInFlight else {
            lock.unlock()
            return
        }
        let interval = probedReachability == false ? reachabilityRetryInterval : reachabilityRecheckInterval
        let isDue = lastProbeStartedAt.map { Date().timeIntervalSince($0) >= interval } ?? true
        guard force || isDue else {
            lock.unlock()
            return
        }
        probeInFlight = true
        lastProbeStartedAt = Date()
        let generation = probeGeneration
        lock.unlock()

        var request = URLRequest(
            url: reachabilityProbeURL,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: reachabilityProbeTimeout
        )
        request.httpMethod = "GET"
        probeSession.dataTask(with: request) { _, response, error in
            let isReachable = error == nil && (response as? HTTPURLResponse)?.statusCode == 204
            lock.lock()
            probeInFlight = false
            let isStale = generation != probeGeneration
            if !isStale {
                probedReachability = isReachable
            }
            lock.unlock()
            if isStale {
                probeReachability(force: true)
            }
        }.resume()
    }

    private static func currentRadioTechnologies() -> [String] {
        telephonyInfo.serviceCurrentRadioAccessTechnology.map { Array($0.values) } ?? []
    }

    // The caller holds `lock`.
    private static func readBattery(_ device: UIDevice) {
        cachedBatteryLevel = batteryPercent(device.batteryLevel)
        cachedIsCharging = isCharging(device.batteryState)
    }

    /// Whole percent from 0 to 100, or nil when the system reports no level.
    static func batteryPercent(_ level: Float) -> Int? {
        guard level >= 0 else {
            return nil
        }
        return min(100, Int((level * 100).rounded()))
    }

    /// True when connected to power, whether charging or full.
    static func isCharging(_ state: UIDevice.BatteryState) -> Bool? {
        switch state {
        case .charging, .full:
            return true
        case .unplugged:
            return false
        default:
            return nil
        }
    }

    static func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal:
            return "nominal"
        case .fair:
            return "fair"
        case .serious:
            return "serious"
        case .critical:
            return "critical"
        @unknown default:
            return "critical"
        }
    }

    static func connectionType(
        status: NWPath.Status,
        interfaceType: NWInterface.InterfaceType?
    ) -> String {
        guard status == .satisfied else {
            return "unavailable"
        }
        switch interfaceType {
        case .wifi:
            return "wifi"
        case .cellular:
            return "cell"
        case .wiredEthernet:
            return "wired"
        default:
            return "unknown"
        }
    }

    /// Maps a `CTRadioAccessTechnology` value to an OpenTelemetry subtype name.
    static func connectionSubtypeName(radioTechnologies: [String]) -> String? {
        for technology in radioTechnologies.sorted() {
            if let name = radioTechnologyNames[technology] {
                return name
            }
        }
        return nil
    }

    private static let radioTechnologyNames: [String: String] = {
        var names: [String: String] = [
            CTRadioAccessTechnologyGPRS: "gprs",
            CTRadioAccessTechnologyEdge: "edge",
            CTRadioAccessTechnologyWCDMA: "umts",
            CTRadioAccessTechnologyHSDPA: "hsdpa",
            CTRadioAccessTechnologyHSUPA: "hsupa",
            CTRadioAccessTechnologyCDMA1x: "cdma",
            CTRadioAccessTechnologyCDMAEVDORev0: "evdo_0",
            CTRadioAccessTechnologyCDMAEVDORevA: "evdo_a",
            CTRadioAccessTechnologyCDMAEVDORevB: "evdo_b",
            CTRadioAccessTechnologyeHRPD: "ehrpd",
            CTRadioAccessTechnologyLTE: "lte",
        ]
        if #available(iOS 14.1, *) {
            names[CTRadioAccessTechnologyNRNSA] = "nrnsa"
            names[CTRadioAccessTechnologyNR] = "nr"
        }
        return names
    }()
}
