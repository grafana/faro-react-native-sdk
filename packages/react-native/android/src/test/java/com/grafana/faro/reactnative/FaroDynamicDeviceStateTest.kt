package com.grafana.faro.reactnative

import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.telephony.TelephonyManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroDynamicDeviceStateTest {

    private val context: Context = ApplicationProvider.getApplicationContext()


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

    @Suppress("DEPRECATION")
    private fun sendBattery(level: Int, plugged: Int) {
        context.sendStickyBroadcast(
            Intent(Intent.ACTION_BATTERY_CHANGED)
                .putExtra(BatteryManager.EXTRA_LEVEL, level)
                .putExtra(BatteryManager.EXTRA_SCALE, 100)
                .putExtra(BatteryManager.EXTRA_PLUGGED, plugged),
        )
    }
}
