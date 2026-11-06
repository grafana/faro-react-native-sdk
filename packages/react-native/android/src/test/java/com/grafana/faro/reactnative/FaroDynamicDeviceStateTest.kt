package com.grafana.faro.reactnative

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
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
    }

    @Test
    fun current_followsBatteryBroadcastsWithoutRereadingTheSystem() {
        sendBattery(level = 80, plugged = 0)
        startAllGroups()
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
        startAllGroups()
        assertEquals(64, FaroDynamicDeviceState.current(context)[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])

        context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        shadowOf(android.os.Looper.getMainLooper()).idle()

        val state = FaroDynamicDeviceState.current(context)
        assertEquals(64, state[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])
        assertEquals(true, state[FaroDynamicDeviceState.IS_CHARGING_KEY])
    }

    @Test
    fun start_registersNothingForAGroupThatIsOff() {
        sendBattery(level = 80, plugged = 0)
        shadowOf(application.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
            .setActiveNetworkInfo(null)

        FaroDynamicDeviceState.start(context, battery = false, thermal = false, network = false)

        assertTrue(FaroDynamicDeviceState.current(context).isEmpty())
        assertTrue(shadowOf(application).registeredReceivers.isEmpty())
    }

    @Test
    fun start_collectsOnlyTheBatteryWhenThermalAndNetworkAreOff() {
        sendBattery(level = 80, plugged = 0)

        FaroDynamicDeviceState.start(context, battery = true, thermal = false, network = false)

        val state = FaroDynamicDeviceState.current(context)
        assertEquals(80, state[FaroDynamicDeviceState.BATTERY_LEVEL_KEY])
        assertFalse(state.containsKey(FaroDynamicDeviceState.THERMAL_STATE_KEY))
        assertFalse(state.containsKey(FaroDynamicDeviceState.CONNECTION_TYPE_KEY))
        assertFalse(state.containsKey(FaroDynamicDeviceState.CARRIER_NAME_KEY))
    }

    @Test
    fun start_leavesTheBatteryUnregisteredWhenOnlyTheNetworkIsOn() {
        sendBattery(level = 80, plugged = 0)

        FaroDynamicDeviceState.start(context, battery = false, thermal = false, network = true)

        val state = FaroDynamicDeviceState.current(context)
        assertFalse(state.containsKey(FaroDynamicDeviceState.BATTERY_LEVEL_KEY))
        assertFalse(state.containsKey(FaroDynamicDeviceState.IS_CHARGING_KEY))
        assertFalse(state.containsKey(FaroDynamicDeviceState.LOW_POWER_MODE_KEY))
    }

    @Test
    fun start_startsAGroupOnlyOnce() {
        sendBattery(level = 80, plugged = 0)

        FaroDynamicDeviceState.start(context, battery = true, thermal = false, network = false)
        val registered = shadowOf(application).registeredReceivers.size
        FaroDynamicDeviceState.start(context, battery = true, thermal = false, network = false)

        assertEquals(registered, shadowOf(application).registeredReceivers.size)
    }

    private val application: Application get() = context as Application

    private fun startAllGroups() {
        FaroDynamicDeviceState.start(context, battery = true, thermal = true, network = true)
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
