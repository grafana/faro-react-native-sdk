package com.grafana.faro.reactnative

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists pending ANR payloads between detection and JS delivery.
 *
 * ANRs are written with [commit] on the ANR tracker thread as soon as the 5s
 * threshold fires, so a process kill before the React bridge can emit still
 * leaves a recoverable record for the next launch.
 */
internal object FaroAnrCache {
    private const val PREFS_NAME = "com.grafana.faro.anr_cache"
    private const val KEY_PENDING_ANRS = "pending_anrs"
    private const val KEY_DETECTED_ANR_TIMESTAMPS = "detected_anr_timestamps"
    private const val MAX_PENDING_ENTRIES = 50
    private const val MAX_DETECTED_TIMESTAMP_ENTRIES = 50
    /** Match window between ANRTracker detection time and ApplicationExitInfo exit time. */
    private const val MAX_TIMESTAMP_DELTA_MS = 10_000L

    fun savePendingAnr(context: Context, payload: String) {
        val newObj = try {
            JSONObject(payload)
        } catch (_: Exception) {
            return
        }
        val newTimestamp = newObj.optLong("timestamp", 0L)
        if (newTimestamp == 0L) {
            return
        }

        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val array = JSONArray(prefs.getString(KEY_PENDING_ANRS, "[]") ?: "[]")

        for (i in 0 until array.length()) {
            val existing = array.optJSONObject(i) ?: continue
            if (existing.optLong("timestamp", 0L) == newTimestamp) {
                return
            }
        }

        array.put(newObj)
        trimOldestEntries(array)

        recordDetectionTimestamp(prefs, newTimestamp)

        // commit() not apply(): the process may be killed immediately after ANR detection.
        prefs.edit()
            .putString(KEY_PENDING_ANRS, array.toString())
            .commit()
    }

    /**
     * Returns true when Faro already recorded an ANR near [exitTimestampMs].
     * Used to skip ApplicationExitInfo crash replays of the same blocked-main-thread event.
     */
    fun hasNearbyAnrDetection(context: Context, exitTimestampMs: Long): Boolean {
        if (exitTimestampMs <= 0L) {
            return false
        }

        for (payload in getPendingAnrs(context)) {
            val timestamp = try {
                JSONObject(payload).optLong("timestamp", 0L)
            } catch (_: Exception) {
                0L
            }
            if (isWithinDetectionWindow(timestamp, exitTimestampMs)) {
                return true
            }
        }

        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val detected = JSONArray(prefs.getString(KEY_DETECTED_ANR_TIMESTAMPS, "[]") ?: "[]")
        for (i in 0 until detected.length()) {
            val timestamp = detected.optLong(i, 0L)
            if (isWithinDetectionWindow(timestamp, exitTimestampMs)) {
                return true
            }
        }

        return false
    }

    private fun recordDetectionTimestamp(prefs: SharedPreferences, timestampMs: Long) {
        val detected = JSONArray(prefs.getString(KEY_DETECTED_ANR_TIMESTAMPS, "[]") ?: "[]")
        for (i in 0 until detected.length()) {
            if (detected.optLong(i, 0L) == timestampMs) {
                return
            }
        }
        detected.put(timestampMs)
        while (detected.length() > MAX_DETECTED_TIMESTAMP_ENTRIES) {
            detected.remove(0)
        }
        prefs.edit()
            .putString(KEY_DETECTED_ANR_TIMESTAMPS, detected.toString())
            .commit()
    }

    private fun isWithinDetectionWindow(anrTimestampMs: Long, exitTimestampMs: Long): Boolean {
        if (anrTimestampMs <= 0L) {
            return false
        }
        return kotlin.math.abs(exitTimestampMs - anrTimestampMs) <= MAX_TIMESTAMP_DELTA_MS
    }

    fun getPendingAnrs(context: Context): List<String> {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val array = JSONArray(prefs.getString(KEY_PENDING_ANRS, "[]") ?: "[]")
        val result = ArrayList<String>(array.length())
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            result.add(obj.toString())
        }
        return result
    }

    /** Records an ANR exit timestamp so [FaroCrashReporter] skips duplicate crash rows. */
    fun recordDetectionTimestamp(context: Context, timestampMs: Long) {
        if (timestampMs <= 0L) {
            return
        }
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        recordDetectionTimestamp(prefs, timestampMs)
    }

    fun acknowledgeAnrs(context: Context, timestamps: Collection<Long>) {
        if (timestamps.isEmpty()) {
            return
        }

        val timestampSet = timestamps.toSet()
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val array = JSONArray(prefs.getString(KEY_PENDING_ANRS, "[]") ?: "[]")
        val remaining = JSONArray()

        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            if (obj.optLong("timestamp", 0L) !in timestampSet) {
                remaining.put(obj)
            }
        }

        prefs.edit()
            .putString(KEY_PENDING_ANRS, remaining.toString())
            .commit()
    }

    private fun trimOldestEntries(array: JSONArray) {
        while (array.length() > MAX_PENDING_ENTRIES) {
            array.remove(0)
        }
    }
}
