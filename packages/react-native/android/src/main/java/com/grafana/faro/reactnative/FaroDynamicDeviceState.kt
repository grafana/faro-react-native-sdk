package com.grafana.faro.reactnative

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.telephony.TelephonyManager
import androidx.annotation.RequiresApi
import androidx.annotation.VisibleForTesting

/**
 * Device and network values that change while the app runs.
 *
 * Each group (battery, thermal, network) starts only when the app asks for it, so a disabled
 * group registers no listener and reads nothing from the system.
 *
 * Battery, Battery Saver, thermal state and connection type come from system listeners that
 * update cached values. The connection subtype and the carrier name are read on
 * demand: the listeners for them need the `READ_PHONE_STATE` runtime permission from API 31, and
 * this SDK asks for no runtime permission. The subtype comes from `TelephonyManager` on API 33+,
 * where the install-time `READ_BASIC_PHONE_STATE` permission allows it, and from the deprecated
 * `NetworkInfo` below. Every value is omitted when it cannot be read.
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

    private val lock = Any()
    private var batteryStarted = false
    private var thermalStarted = false
    @Volatile private var networkStarted = false

    @Volatile private var batteryLevel: Int? = null
    @Volatile private var isCharging: Boolean? = null
    @Volatile private var lowPowerMode: Boolean? = null
    @Volatile private var thermalState: String? = null
    @Volatile private var connectionType: String? = null

    // Only read and written on the connectivity callback thread, so the default network's loss is
    // not confused with the loss of a network it replaced.
    private var defaultNetwork: Network? = null

    /** The cached values of the started groups plus the on-demand subtype and carrier. */
    fun current(context: Context?): Map<String, Any> {
        if (context == null) {
            return emptyMap()
        }

        val applicationContext = context.applicationContext ?: context
        val state = mutableMapOf<String, Any>()
        batteryLevel?.let { state[BATTERY_LEVEL_KEY] = it }
        isCharging?.let { state[IS_CHARGING_KEY] = it }
        lowPowerMode?.let { state[LOW_POWER_MODE_KEY] = it }
        thermalState?.let { state[THERMAL_STATE_KEY] = it }
        if (networkStarted) {
            val type = connectionType
            type?.let { state[CONNECTION_TYPE_KEY] = it }
            if (type == "cell") {
                readConnectionSubtype(applicationContext)?.let { state[CONNECTION_SUBTYPE_KEY] = it }
            }
            readCarrierName(applicationContext)?.let { state[CARRIER_NAME_KEY] = it }
        }
        return state
    }

    /**
     * Registers the listeners of the enabled groups and seeds their cache. A group starts once and
     * a group that is off is never touched.
     */
    fun start(context: Context, battery: Boolean, thermal: Boolean, network: Boolean) {
        val applicationContext = context.applicationContext ?: context
        if (battery && claimBattery()) {
            startBatteryListener(applicationContext)
        }
        if (thermal && claimThermal()) {
            startThermalListener(applicationContext)
        }
        if (network && claimNetwork()) {
            startConnectionListener(applicationContext)
        }
    }

    private fun claimBattery(): Boolean = synchronized(lock) {
        !batteryStarted.also { batteryStarted = true }
    }

    private fun claimThermal(): Boolean = synchronized(lock) {
        !thermalStarted.also { thermalStarted = true }
    }

    private fun claimNetwork(): Boolean = synchronized(lock) {
        !networkStarted.also { networkStarted = true }
    }

    private fun startBatteryListener(context: Context) {
        try {
            val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(receiverContext: Context?, intent: Intent?) {
                    // Only the battery broadcast has battery extras. Reading them from the
                    // Battery Saver broadcast would clear the level and the charging state.
                    if (intent?.action == Intent.ACTION_BATTERY_CHANGED) {
                        readBattery(intent)
                    }
                    readLowPowerMode(receiverContext)
                }
            }
            // Battery changes are sticky, so registering also returns the current value.
            readBattery(context.registerReceiver(receiver, filter))
            readLowPowerMode(context)
        } catch (_: RuntimeException) {
            // Battery state stays unknown and is omitted.
        }
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

    @VisibleForTesting
    internal fun applyCapabilities(capabilities: NetworkCapabilities) {
        connectionType = connectionTypeName(
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
        )
    }

    /** Reads the active network once. */
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
                return
            }
            connectionType = connectionTypeName(
                info.type == ConnectivityManager.TYPE_WIFI,
                info.type == ConnectivityManager.TYPE_MOBILE,
                info.type == ConnectivityManager.TYPE_ETHERNET,
            )
        } catch (_: RuntimeException) {
            // Unknown, so omitted.
        }
    }

    @VisibleForTesting
    internal fun readConnectionSubtype(context: Context): String? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                readDataNetworkType(context)
            } else {
                readNetworkInfoSubtype(context)
            }
        } catch (_: RuntimeException) {
            null
        }
    }

    // READ_BASIC_PHONE_STATE is a normal permission, but an app can remove it from its manifest.
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun readDataNetworkType(context: Context): String? {
        if (context.checkSelfPermission(Manifest.permission.READ_BASIC_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }

        val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        return telephonyManager?.dataNetworkType?.let { connectionSubtypeName(it) }
    }

    // Before API 33 the deprecated NetworkInfo is the only subtype source that needs no permission.
    @Suppress("DEPRECATION")
    private fun readNetworkInfoSubtype(context: Context): String? {
        val connectivityManager =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        return connectivityManager?.activeNetworkInfo?.let { connectionSubtypeName(it.subtype) }
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

    /** Forgets the listeners and the cache, so a test can start from the beginning. */
    @VisibleForTesting
    fun resetForTests() {
        synchronized(lock) {
            batteryStarted = false
            thermalStarted = false
            networkStarted = false
        }
        batteryLevel = null
        isCharging = null
        lowPowerMode = null
        thermalState = null
        connectionType = null
        defaultNetwork = null
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
