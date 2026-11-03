package com.grafana.faro.reactnative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.telephony.TelephonyManager
import androidx.annotation.VisibleForTesting

/**
 * Device and network values that change while the app runs.
 *
 * Battery, Battery Saver, thermal state, connection type and reachability come from system
 * listeners that update cached values. The connection subtype and the carrier name are read on
 * demand: the listeners for them need the `READ_PHONE_STATE` runtime permission from API 31, and
 * this SDK asks for no runtime permission. Every value is omitted when it cannot be read.
 *
 * Ported from the Faro Flutter SDK's `DynamicDeviceState`.
 */
internal object FaroDynamicDeviceState {
    const val BATTERY_LEVEL_KEY = "batteryLevel"
    const val IS_CHARGING_KEY = "isCharging"
    const val LOW_POWER_MODE_KEY = "lowPowerMode"
    const val THERMAL_STATE_KEY = "thermalState"
    const val CONNECTION_TYPE_KEY = "connectionType"
    const val CONNECTION_SUBTYPE_KEY = "connectionSubtype"
    const val CARRIER_NAME_KEY = "carrierName"
    const val REACHABLE_KEY = "reachable"

    private val lock = Any()
    private var started = false

    @Volatile private var batteryLevel: Int? = null
    @Volatile private var isCharging: Boolean? = null
    @Volatile private var lowPowerMode: Boolean? = null
    @Volatile private var thermalState: String? = null
    @Volatile private var connectionType: String? = null
    @Volatile private var reachable: Boolean? = null

    // Only read and written on the connectivity callback thread, so the default network's loss is
    // not confused with the loss of a network it replaced.
    private var defaultNetwork: Network? = null

    /** The cached values plus the probed subtype and carrier. Starts the listeners once. */
    fun current(context: Context?): Map<String, Any> {
        if (context == null) {
            return emptyMap()
        }

        val applicationContext = context.applicationContext ?: context
        start(applicationContext)

        val state = mutableMapOf<String, Any>()
        batteryLevel?.let { state[BATTERY_LEVEL_KEY] = it }
        isCharging?.let { state[IS_CHARGING_KEY] = it }
        lowPowerMode?.let { state[LOW_POWER_MODE_KEY] = it }
        thermalState?.let { state[THERMAL_STATE_KEY] = it }
        connectionType?.let { state[CONNECTION_TYPE_KEY] = it }
        reachable?.let { state[REACHABLE_KEY] = it }
        if (connectionType == "cell") {
            readConnectionSubtype(applicationContext)?.let { state[CONNECTION_SUBTYPE_KEY] = it }
        }
        readCarrierName(applicationContext)?.let { state[CARRIER_NAME_KEY] = it }
        return state
    }

    /** Registers the listeners once and seeds the cache from the current state. */
    fun start(context: Context) {
        synchronized(lock) {
            if (started) {
                return
            }
            started = true
        }

        try {
            val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(receiverContext: Context?, intent: Intent?) {
                    readBattery(intent)
                    readLowPowerMode(receiverContext)
                }
            }
            // Battery changes are sticky, so registering also returns the current value.
            readBattery(context.registerReceiver(receiver, filter))
            readLowPowerMode(context)
        } catch (_: RuntimeException) {
            // Battery state stays unknown and is omitted.
        }

        startThermalListener(context)
        startConnectionListener(context)
    }

    private fun readBattery(intent: Intent?) {
        if (intent == null) {
            return
        }

        batteryLevel = batteryPercent(
            intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
            intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1),
        )
        isCharging = isPluggedIn(intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0))
    }

    private fun readLowPowerMode(context: Context?) {
        try {
            val powerManager = context?.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (powerManager != null) {
                lowPowerMode = powerManager.isPowerSaveMode
            }
        } catch (_: RuntimeException) {
            // Unknown, so omitted.
        }
    }

    private fun startThermalListener(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return
        }

        try {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            thermalState = thermalStateName(powerManager.currentThermalStatus)
            powerManager.addThermalStatusListener(context.mainExecutor) { status ->
                thermalState = thermalStateName(status)
            }
        } catch (_: RuntimeException) {
            // Unknown, so omitted.
        }
    }

    private fun startConnectionListener(context: Context) {
        try {
            val connectivityManager =
                context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return

            // Seeds the cache. The listeners below only report changes after this.
            readConnection(connectivityManager)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                connectivityManager.registerDefaultNetworkCallback(
                    object : ConnectivityManager.NetworkCallback() {
                        override fun onCapabilitiesChanged(
                            network: Network,
                            capabilities: NetworkCapabilities,
                        ) {
                            defaultNetwork = network
                            applyCapabilities(capabilities)
                        }

                        override fun onLost(network: Network) {
                            if (network == defaultNetwork) {
                                defaultNetwork = null
                                connectionType = "unavailable"
                                reachable = false
                            }
                        }
                    },
                )
            } else {
                // Before API 24 there is no default network callback.
                @Suppress("DEPRECATION")
                context.registerReceiver(
                    object : BroadcastReceiver() {
                        override fun onReceive(receiverContext: Context?, intent: Intent?) {
                            readConnection(connectivityManager)
                        }
                    },
                    IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION),
                )
            }
        } catch (_: RuntimeException) {
            // Without ACCESS_NETWORK_STATE the connection stays unknown and is omitted.
        }
    }

    private fun applyCapabilities(capabilities: NetworkCapabilities) {
        connectionType = connectionTypeName(
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
        )
        // VALIDATED is the system's own internet check, which is how a wifi network without
        // internet reads as unreachable.
        reachable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** Reads the active network once. Before API 23 there is no internet check, so reachability is omitted. */
    @Suppress("DEPRECATION")
    private fun readConnection(connectivityManager: ConnectivityManager) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val capabilities = connectivityManager.activeNetwork
                    ?.let { connectivityManager.getNetworkCapabilities(it) }
                if (capabilities != null) {
                    applyCapabilities(capabilities)
                    return
                }
            }

            val info = connectivityManager.activeNetworkInfo
            if (info?.isConnected != true) {
                connectionType = "unavailable"
                reachable = false
                return
            }
            connectionType = connectionTypeName(
                info.type == ConnectivityManager.TYPE_WIFI,
                info.type == ConnectivityManager.TYPE_MOBILE,
                info.type == ConnectivityManager.TYPE_ETHERNET,
            )
            reachable = null
        } catch (_: RuntimeException) {
            // Unknown, so omitted.
        }
    }

    // The deprecated NetworkInfo is the only subtype source that needs no permission.
    @Suppress("DEPRECATION")
    private fun readConnectionSubtype(context: Context): String? {
        return try {
            val connectivityManager =
                context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            connectivityManager?.activeNetworkInfo?.let { connectionSubtypeName(it.subtype) }
        } catch (_: RuntimeException) {
            null
        }
    }

    // getNetworkOperatorName needs no permission, unlike the SIM and data-network calls that need
    // READ_PHONE_STATE.
    private fun readCarrierName(context: Context): String? {
        return try {
            val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
            telephonyManager?.networkOperatorName?.trim()?.takeIf(String::isNotEmpty)
        } catch (_: RuntimeException) {
            null
        }
    }

    /** Whole percent from 0 to 100, or null when the system reports no level. */
    @VisibleForTesting
    fun batteryPercent(level: Int, scale: Int): Int? {
        if (level < 0 || scale <= 0) {
            return null
        }
        return minOf(100, level * 100 / scale)
    }

    /** True for AC, USB or wireless power, whether it charges or the battery is full. */
    @VisibleForTesting
    fun isPluggedIn(plugged: Int): Boolean {
        val power = BatteryManager.BATTERY_PLUGGED_AC or
            BatteryManager.BATTERY_PLUGGED_USB or
            BatteryManager.BATTERY_PLUGGED_WIRELESS
        return plugged and power != 0
    }

    /**
     * Maps `PowerManager.THERMAL_STATUS_*`: none to nominal, light to fair, moderate to serious,
     * and severe and above to critical.
     */
    @VisibleForTesting
    fun thermalStateName(status: Int): String? = when {
        status < 0 -> null
        status == 0 -> "nominal"
        status == 1 -> "fair"
        status == 2 -> "serious"
        else -> "critical"
    }

    @VisibleForTesting
    fun connectionTypeName(wifi: Boolean, cellular: Boolean, ethernet: Boolean): String = when {
        wifi -> "wifi"
        cellular -> "cell"
        ethernet -> "wired"
        else -> "unknown"
    }

    /** Maps `TelephonyManager.NETWORK_TYPE_*` to OpenTelemetry subtype names. */
    @VisibleForTesting
    fun connectionSubtypeName(networkType: Int): String? = when (networkType) {
        TelephonyManager.NETWORK_TYPE_GPRS -> "gprs"
        TelephonyManager.NETWORK_TYPE_EDGE -> "edge"
        TelephonyManager.NETWORK_TYPE_UMTS -> "umts"
        TelephonyManager.NETWORK_TYPE_CDMA -> "cdma"
        TelephonyManager.NETWORK_TYPE_EVDO_0 -> "evdo_0"
        TelephonyManager.NETWORK_TYPE_EVDO_A -> "evdo_a"
        TelephonyManager.NETWORK_TYPE_1xRTT -> "cdma2000_1xrtt"
        TelephonyManager.NETWORK_TYPE_HSDPA -> "hsdpa"
        TelephonyManager.NETWORK_TYPE_HSUPA -> "hsupa"
        TelephonyManager.NETWORK_TYPE_HSPA -> "hspa"
        TelephonyManager.NETWORK_TYPE_IDEN -> "iden"
        TelephonyManager.NETWORK_TYPE_EVDO_B -> "evdo_b"
        TelephonyManager.NETWORK_TYPE_LTE -> "lte"
        TelephonyManager.NETWORK_TYPE_EHRPD -> "ehrpd"
        TelephonyManager.NETWORK_TYPE_HSPAP -> "hspap"
        16 -> "gsm" // NETWORK_TYPE_GSM, API 25
        17 -> "td_scdma" // NETWORK_TYPE_TD_SCDMA, API 25
        18 -> "iwlan" // NETWORK_TYPE_IWLAN, API 25
        19 -> "lte_ca" // NETWORK_TYPE_LTE_CA, API 25
        20 -> "nr" // NETWORK_TYPE_NR, API 29
        else -> null
    }
}
