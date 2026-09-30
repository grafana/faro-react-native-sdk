package com.grafana.faro.reactnative

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/** Whether the device is connected to a power source, read from the sticky battery broadcast. */
internal object FaroPowerSource {
    /**
     * Returns true when plugged into AC, USB, wireless or a dock, even if charging is paused
     * (battery protection, charge limits, heat). Returns null when the broadcast is unavailable.
     */
    fun isConnected(context: Context): Boolean? {
        val batteryStatus = try {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (_: Exception) {
            null
        }

        return isConnected(batteryStatus?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1))
    }

    internal fun isConnected(plugged: Int?): Boolean? {
        if (plugged == null || plugged < 0) {
            return null
        }

        return plugged != 0
    }
}
