package com.grafana.faro.reactnative

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.telephony.TelephonyManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetworkCapabilities
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroDynamicDeviceStateTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    // The state is a singleton that registers its listeners once, on the first context it sees.
    @Before
    fun resetState() {
        FaroDynamicDeviceState.resetForTests()
    }


    @Test
    fun batteryPercent_isAWholePercent() {
        assertEquals(0, FaroDynamicDeviceState.batteryPercent(0, 100))
        assertEquals(100, FaroDynamicDeviceState.batteryPercent(100, 100))
        assertEquals(50, FaroDynamicDeviceState.batteryPercent(127, 254))
    }

    @Test
    fun batteryPercent_isNullWhenTheSystemReportsNoLevel() {
        assertNull(FaroDynamicDeviceState.batteryPercent(-1, 100))
        assertNull(FaroDynamicDeviceState.batteryPercent(50, -1))
        assertNull(FaroDynamicDeviceState.batteryPercent(50, 0))
    }

    @Test
    fun batteryPercent_neverExceedsOneHundred() {
        assertEquals(100, FaroDynamicDeviceState.batteryPercent(120, 100))
    }

    @Test
    fun isPluggedIn_isTrueForEveryPowerSource() {
        assertTrue(FaroDynamicDeviceState.isPluggedIn(BatteryManager.BATTERY_PLUGGED_AC))
        assertTrue(FaroDynamicDeviceState.isPluggedIn(BatteryManager.BATTERY_PLUGGED_USB))
        assertTrue(FaroDynamicDeviceState.isPluggedIn(BatteryManager.BATTERY_PLUGGED_WIRELESS))
    }

    @Test
    fun isPluggedIn_isFalseOnBattery() {
        assertFalse(FaroDynamicDeviceState.isPluggedIn(0))
    }

    @Test
    fun thermalStateName_mapsToFourStates() {
        assertEquals("nominal", FaroDynamicDeviceState.thermalStateName(0))
        assertEquals("fair", FaroDynamicDeviceState.thermalStateName(1))
        assertEquals("serious", FaroDynamicDeviceState.thermalStateName(2))
        for (status in 3..6) {
            assertEquals("critical", FaroDynamicDeviceState.thermalStateName(status))
        }
    }

    @Test
    fun thermalStateName_isNullForAnUnknownStatus() {
        assertNull(FaroDynamicDeviceState.thermalStateName(-1))
    }

    @Test
    fun connectionTypeName_prefersWifiThenCellThenWired() {
        assertEquals("wifi", FaroDynamicDeviceState.connectionTypeName(true, true, true))
        assertEquals("cell", FaroDynamicDeviceState.connectionTypeName(false, true, true))
        assertEquals("wired", FaroDynamicDeviceState.connectionTypeName(false, false, true))
        assertEquals("unknown", FaroDynamicDeviceState.connectionTypeName(false, false, false))
    }

    @Test
    fun connectionSubtypeName_mapsToOpenTelemetryNames() {
        assertEquals("lte", FaroDynamicDeviceState.connectionSubtypeName(TelephonyManager.NETWORK_TYPE_LTE))
        assertEquals("nr", FaroDynamicDeviceState.connectionSubtypeName(20))
        assertEquals("lte_ca", FaroDynamicDeviceState.connectionSubtypeName(19))
        assertEquals("hspap", FaroDynamicDeviceState.connectionSubtypeName(TelephonyManager.NETWORK_TYPE_HSPAP))
        assertEquals(
            "cdma2000_1xrtt",
            FaroDynamicDeviceState.connectionSubtypeName(TelephonyManager.NETWORK_TYPE_1xRTT),
        )
    }

    @Test
    fun connectionSubtypeName_isNullForAnUnknownType() {
        assertNull(FaroDynamicDeviceState.connectionSubtypeName(TelephonyManager.NETWORK_TYPE_UNKNOWN))
    }

    @Test
    fun current_isEmptyWithoutAContext() {
        assertTrue(FaroDynamicDeviceState.current(null).isEmpty())
    }

    @Test
    fun keys_matchTheJavaScriptSide() {
        assertEquals("batteryLevel", FaroDynamicDeviceState.BATTERY_LEVEL_KEY)
        assertEquals("isCharging", FaroDynamicDeviceState.IS_CHARGING_KEY)
        assertEquals("lowPowerMode", FaroDynamicDeviceState.LOW_POWER_MODE_KEY)
        assertEquals("thermalState", FaroDynamicDeviceState.THERMAL_STATE_KEY)
        assertEquals("connectionType", FaroDynamicDeviceState.CONNECTION_TYPE_KEY)
        assertEquals("connectionSubtype", FaroDynamicDeviceState.CONNECTION_SUBTYPE_KEY)
        assertEquals("carrierName", FaroDynamicDeviceState.CARRIER_NAME_KEY)
        assertEquals("reachable", FaroDynamicDeviceState.REACHABLE_KEY)
    }

    @Test
    fun current_followsBatteryBroadcastsWithoutRereadingTheSystem() {
        sendBattery(level = 80, plugged = 0)
        assertEquals(80, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])
        assertEquals(false, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.IS_CHARGING_KEY])

        sendBattery(level = 79, plugged = BatteryManager.BATTERY_PLUGGED_USB)
        shadowOf(android.os.Looper.getMainLooper()).idle()

        assertEquals(79, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])
        assertEquals(true, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.IS_CHARGING_KEY])
    }

    @Test
    fun current_keepsTheBatteryStateWhenBatterySaverChanges() {
        sendBattery(level = 64, plugged = BatteryManager.BATTERY_PLUGGED_AC)
        assertEquals(64, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])

        context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        shadowOf(android.os.Looper.getMainLooper()).idle()

        val state = FaroDynamicDeviceState.current(context)
        assertEquals(64, state[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])
        assertEquals(true, state[FaroDynamicDeviceState.IS_CHARGING_KEY])
    }

    @Test
    fun current_neverPairsTheTypeOfOneNetworkWithTheReachabilityOfAnother() {
        val wifi = capabilities(NetworkCapabilities.TRANSPORT_WIFI, validated = true)
        val cell = capabilities(NetworkCapabilities.TRANSPORT_CELLULAR, validated = false)
        val reachabilityOf = mapOf("wifi" to true, "cell" to false)
        // The first read starts the listeners and seeds the cache, so do it before the writer runs.
        FaroDynamicDeviceState.current(context)

        val stop = AtomicBoolean(false)
        val writer = thread {
            var flip = false
            while (!stop.get()) {
                FaroDynamicDeviceState.applyCapabilities(if (flip) wifi else cell)
                flip = !flip
            }
        }
        try {
            repeat(20_000) {
                val state = FaroDynamicDeviceState.current(context)
                val type = state[FaroDynamicDeviceState.CONNECTION_TYPE_KEY]
                if (type in reachabilityOf) {
                    assertEquals(reachabilityOf[type], state[FaroDynamicDeviceState.REACHABLE_KEY])
                }
            }
        } finally {
            stop.set(true)
            writer.join()
        }
    }

    private fun capabilities(transport: Int, validated: Boolean): NetworkCapabilities {
        val capabilities = ShadowNetworkCapabilities.newInstance()
        shadowOf(capabilities).addTransportType(transport)
        if (validated) {
            shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
        return capabilities
    }

    @Suppress("DEPRECATION")
    private fun sendBattery(level: Int, plugged: Int) {
        context.sendStickyBroadcast(
            Intent(Intent.ACTION_BATTERY_CHANGED)
                .putExtra(BatteryManager.EXTRA_LEVEL, level)
                .putExtra(BatteryManager.EXTRA_SCALE, 100)
                .putExtra(BatteryManager.EXTRA_PLUGGED, plugged),
        )
    }

    @Test
    @Config(manifest = Config.NONE, sdk = [33])
    fun connectionSubtype_usesTheDataNetworkTypeWhenReadBasicPhoneStateIsGranted() {
        val application = context as Application
        shadowOf(application).grantPermissions("android.permission.READ_BASIC_PHONE_STATE")
        val telephonyManager = application.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        shadowOf(telephonyManager).setDataNetworkType(TelephonyManager.NETWORK_TYPE_LTE)

        assertEquals("lte", FaroDynamicDeviceState.readConnectionSubtype(application))
    }

    @Test
    @Config(manifest = Config.NONE, sdk = [33])
    fun connectionSubtype_isOmittedWhenReadBasicPhoneStateIsDenied() {
        val application = context as Application
        shadowOf(application).denyPermissions("android.permission.READ_BASIC_PHONE_STATE")
        val telephonyManager = application.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        shadowOf(telephonyManager).setDataNetworkType(TelephonyManager.NETWORK_TYPE_LTE)

        assertNull(FaroDynamicDeviceState.readConnectionSubtype(application))
    }
}
