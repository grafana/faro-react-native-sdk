package com.grafana.faro.reactnative

import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class FaroPowerSourceTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun isConnected_treatsEveryPlugTypeAsConnected() {
        for (plugged in listOf(
            BatteryManager.BATTERY_PLUGGED_AC,
            BatteryManager.BATTERY_PLUGGED_USB,
            BatteryManager.BATTERY_PLUGGED_WIRELESS,
            BatteryManager.BATTERY_PLUGGED_DOCK,
        )) {
            assertEquals(true, FaroPowerSource.isConnected(plugged))
        }
    }

    @Test
    fun isConnected_reportsUnpluggedAsDisconnected() {
        assertEquals(false, FaroPowerSource.isConnected(0))
    }

    @Test
    fun isConnected_returnsNullWhenThePlugTypeIsMissing() {
        assertNull(FaroPowerSource.isConnected(null))
        assertNull(FaroPowerSource.isConnected(-1))
    }

    @Test
    fun isConnected_reportsPluggedInWhileChargingIsPaused() {
        sendBatteryStatus(
            plugged = BatteryManager.BATTERY_PLUGGED_USB,
            status = BatteryManager.BATTERY_STATUS_NOT_CHARGING,
        )

        assertEquals(true, FaroPowerSource.isConnected(context))
    }

    @Test
    fun isConnected_reportsUnpluggedFromTheBatteryBroadcast() {
        sendBatteryStatus(plugged = 0, status = BatteryManager.BATTERY_STATUS_DISCHARGING)

        assertEquals(false, FaroPowerSource.isConnected(context))
    }

    @Suppress("DEPRECATION")
    private fun sendBatteryStatus(plugged: Int, status: Int) {
        context.sendStickyBroadcast(
            Intent(Intent.ACTION_BATTERY_CHANGED)
                .putExtra(BatteryManager.EXTRA_PLUGGED, plugged)
                .putExtra(BatteryManager.EXTRA_STATUS, status),
        )
    }
}
