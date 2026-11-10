import CoreTelephony
import Foundation
import Network
import UIKit

/// Device and network values that change while the app runs.
///
/// Notifications and a path monitor update a lock-protected cache, so `current()` is safe to call
/// from any thread and reads nothing from the system. Each group (battery, thermal, network) starts
/// only when the app asks for it. Nothing here needs a permission, and every
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

    private static let lock = NSLock()
    private static var batteryStarted = false
    private static var thermalStarted = false
    private static var networkStarted = false
    private static var owners: [ObjectIdentifier: (battery: Bool, thermal: Bool, network: Bool)] = [:]
    private static var batteryObservers: [NSObjectProtocol] = []
    private static var thermalObservers: [NSObjectProtocol] = []
    private static var networkObservers: [NSObjectProtocol] = []
    private static var pathMonitor: NWPathMonitor?
    private static var latestPath: NWPath?
    private static var cachedBatteryLevel: Int?
    private static var cachedIsCharging: Bool?
    private static var cachedLowPowerMode: Bool?
    private static var cachedThermalState: String?
    private static var cachedDataRadioTechnology: String?
    private static let telephonyInfo = CTTelephonyNetworkInfo()

    /// Records the groups a React Native runtime wants and starts the monitoring that no runtime had
    /// asked for yet. A group that is off registers no observer and reads nothing from the system.
    /// UIDevice battery monitoring is main-thread-only, so call it on the main thread, early.
    @MainActor @objc public static func start(owner: AnyObject, battery: Bool, thermal: Bool, network: Bool) {
        lock.lock()
        defer { lock.unlock() }
        owners[ObjectIdentifier(owner)] = (battery, thermal, network)
        reconcile()
    }

    /// Removes a runtime that was torn down and stops every group that no other runtime wants.
    @MainActor @objc public static func detach(owner: AnyObject) {
        lock.lock()
        defer { lock.unlock() }
        if owners.removeValue(forKey: ObjectIdentifier(owner)) != nil {
            reconcile()
        }
    }

    // The caller holds `lock`.
    @MainActor private static func reconcile() {
        let wanted = owners.values
        if wanted.contains(where: { $0.battery }) {
            if !batteryStarted {
                batteryStarted = true
                startBattery()
            }
        } else if batteryStarted {
            batteryStarted = false
            stopBattery()
        }

        if wanted.contains(where: { $0.thermal }) {
            if !thermalStarted {
                thermalStarted = true
                startThermal()
            }
        } else if thermalStarted {
            thermalStarted = false
            stopThermal()
        }

        if wanted.contains(where: { $0.network }) {
            if !networkStarted {
                networkStarted = true
                startNetwork()
            }
        } else if networkStarted {
            networkStarted = false
            stopNetwork()
        }
    }

    // The caller holds `lock`.
    @MainActor private static func startBattery() {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        readBattery(device)
        let center = NotificationCenter.default
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
            batteryObservers.append(
                center.addObserver(forName: name, object: nil, queue: nil) { _ in
                    lock.lock()
                    defer { lock.unlock() }
                    guard batteryStarted else { return }
                    readBattery(UIDevice.current)
                }
            )
        }

        cachedLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        batteryObservers.append(
            center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { _ in
                lock.lock()
                defer { lock.unlock() }
                guard batteryStarted else { return }
                cachedLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
        )
    }

    // The caller holds `lock`.
    @MainActor private static func stopBattery() {
        removeObservers(&batteryObservers)
        UIDevice.current.isBatteryMonitoringEnabled = false
        cachedBatteryLevel = nil
        cachedIsCharging = nil
        cachedLowPowerMode = nil
    }

    // The caller holds `lock`.
    private static func startThermal() {
        cachedThermalState = thermalStateName(ProcessInfo.processInfo.thermalState)
        thermalObservers.append(
            NotificationCenter.default.addObserver(
                forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
            ) { _ in
                lock.lock()
                defer { lock.unlock() }
                guard thermalStarted else { return }
                cachedThermalState = thermalStateName(ProcessInfo.processInfo.thermalState)
            }
        )
    }

    // The caller holds `lock`.
    private static func stopThermal() {
        removeObservers(&thermalObservers)
        cachedThermalState = nil
    }

    // The caller holds `lock`.
    private static func startNetwork() {
        cachedDataRadioTechnology = currentDataRadioTechnology()
        networkObservers.append(
            NotificationCenter.default.addObserver(
                forName: .CTServiceRadioAccessTechnologyDidChange, object: nil, queue: nil
            ) { _ in
                let technology = currentDataRadioTechnology()
                lock.lock()
                defer { lock.unlock() }
                guard networkStarted else { return }
                cachedDataRadioTechnology = technology
            }
        )

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak monitor] path in
            lock.lock()
            defer { lock.unlock() }
            // A cancelled monitor can still deliver one last update.
            guard let monitor, pathMonitor === monitor else { return }
            latestPath = path
            cachedDataRadioTechnology = currentDataRadioTechnology()
        }
        monitor.start(queue: DispatchQueue(label: "com.grafana.faro.network-path", qos: .utility))
        pathMonitor = monitor
    }

    // The caller holds `lock`.
    private static func stopNetwork() {
        removeObservers(&networkObservers)
        pathMonitor?.cancel()
        pathMonitor = nil
        latestPath = nil
        cachedDataRadioTechnology = nil
    }

    private static func removeObservers(_ observers: inout [NSObjectProtocol]) {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    /// The cached values of the started groups. Empty until `start` has run.
    @objc public static func current() -> [String: Any] {
        lock.lock()
        let level = cachedBatteryLevel
        let charging = cachedIsCharging
        let path = latestPath
        let lowPowerMode = cachedLowPowerMode
        let thermalState = cachedThermalState
        let dataRadioTechnology = cachedDataRadioTechnology
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
            let type = connectionType(for: path)
            state[connectionTypeKey] = type
            if type == "cell" {
                if let subtype = connectionSubtypeName(radioTechnology: dataRadioTechnology) {
                    state[connectionSubtypeKey] = subtype
                }
            }
        }
        return state
    }

    /// The radio technology of the SIM that carries mobile data. On a dual-SIM phone the other SIM
    /// can report a different technology, so it must not decide the subtype. Without a known data
    /// SIM and with more than one SIM reporting, there is nothing safe to pick.
    private static func currentDataRadioTechnology() -> String? {
        guard let technologies = telephonyInfo.serviceCurrentRadioAccessTechnology else {
            return nil
        }
        if let dataServiceIdentifier = telephonyInfo.dataServiceIdentifier,
            let technology = technologies[dataServiceIdentifier] {
            return technology
        }
        return technologies.count == 1 ? technologies.values.first : nil
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

    /// Checks the interface types in the same order as Android: wifi, then cell, then wired. A VPN
    /// shows up as an `other` interface and `usesInterfaceType` also reports the interface under it,
    /// so a VPN does not hide the underlying connection.
    static func connectionType(for path: NWPath) -> String {
        guard path.status == .satisfied else {
            return "unavailable"
        }
        if path.usesInterfaceType(.wifi) {
            return "wifi"
        }
        if path.usesInterfaceType(.cellular) {
            return "cell"
        }
        if path.usesInterfaceType(.wiredEthernet) {
            return "wired"
        }
        return "unknown"
    }

    /// Maps a `CTRadioAccessTechnology` value to an OpenTelemetry subtype name.
    static func connectionSubtypeName(radioTechnology: String?) -> String? {
        radioTechnology.flatMap { radioTechnologyNames[$0] }
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
