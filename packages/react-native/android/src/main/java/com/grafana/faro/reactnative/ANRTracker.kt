package com.grafana.faro.reactnative

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.collections.ArrayList

/**
 * ANRTracker detects Application Not Responding (ANR) situations by monitoring the main thread.
 *
 * Implementation ported from Faro Flutter SDK's ANRTracker.java.
 *
 * It posts a task to the main thread and checks if it completes within a specified timeout.
 * If the task doesn't complete in time, it indicates the main thread is blocked (ANR).
 */
class ANRTracker : Thread("ANRTracker") {
    companion object {
        private const val TAG = "ANRTracker"
        
        /**
         * Watchdog check interval in milliseconds (default 5 seconds).
         * Updated from JS via [FaroReactNativeModule.startANRTracking].
         * Exported in ANR payloads as `duration` — the detection threshold, not measured block time.
         */
        var timeout: Long = 5000L
        
        /**
         * Time to wait between checks, in milliseconds
         */
        private const val CHECK_INTERVAL = 500L
        
        /**
         * Thread-safe list to store ANR information
         */
        private val anrList = ArrayList<String>()
        private val anrListLock = Any()
        
        /**
         * Get the list of ANR events that have been detected.
         * @return List of ANR stack traces as JSON strings, or null if no ANRs detected
         */
        fun getANRStatus(): List<String>? {
            synchronized(anrListLock) {
                if (anrList.isEmpty()) {
                    return null
                }
                return ArrayList(anrList)
            }
        }
        
        /**
         * Application context used to persist ANRs before JS delivery.
         */
        @Volatile
        var applicationContext: Context? = null

        /**
         * Remove in-memory ANRs that were acknowledged on disk.
         */
        fun acknowledgeInMemory(timestamps: Collection<Long>) {
            if (timestamps.isEmpty()) {
                return
            }
            val timestampSet = timestamps.toSet()
            synchronized(anrListLock) {
                anrList.removeAll { json ->
                    try {
                        JSONObject(json).optLong("timestamp", 0L) in timestampSet
                    } catch (_: Exception) {
                        false
                    }
                }
            }
        }

        /**
         * Optional callback invoked on the ANR tracker thread when an ANR is recorded.
         * Used to push telemetry immediately instead of waiting for the JS poll interval.
         */
        @Volatile
        var onAnrDetected: ((String) -> Unit)? = null
    }
    
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainThread = Looper.getMainLooper().thread
    private val isRunning = AtomicBoolean(true)
    private val taskExecuted = AtomicBoolean(false)
    
    /** True while the main thread is blocked and we already recorded one ANR for this period. */
    private val anrInProgress = AtomicBoolean(false)
    
    private val checkTask = Runnable {
        // This task runs on the main thread
        taskExecuted.set(true)
    }
    
    override fun run() {
        Log.d(TAG, "Tracking started")
        
        while (isRunning.get() && !isInterrupted) {
            try {
                // Capture start time
                val startTime = System.currentTimeMillis()
                
                // Reset the flag before posting the task
                taskExecuted.set(false)
                
                // Post the task to the main thread
                mainHandler.post(checkTask)
                
                // Wait for a short time to give the main thread a chance to execute the task
                sleep(CHECK_INTERVAL)
                
                // Check if we've been interrupted or should stop
                if (!isRunning.get() || isInterrupted) {
                    Log.d(TAG, "Tracking interrupted or stopped during execution")
                    break
                }
                
                if (taskExecuted.get()) {
                    // Main thread recovered — allow a future blocked period to be reported again.
                    anrInProgress.set(false)
                }

                // If the task hasn't executed after the check interval, start monitoring for ANR
                if (!taskExecuted.get()) {
                    Log.d(TAG, "Task not executed after initial check")
                    
                    // Calculate how much more time to wait for a total of TIMEOUT since we started
                    val elapsedTime = System.currentTimeMillis() - startTime
                    val remainingTime = timeout - elapsedTime
                    
                    // Wait for the remaining time if needed
                    if (remainingTime > 0) {
                        sleep(remainingTime)
                        Log.d(TAG, "Waited additional ${remainingTime}ms")
                        
                        // Check again if we should exit
                        if (!isRunning.get() || isInterrupted) {
                            Log.d(TAG, "Tracking interrupted or stopped during additional wait")
                            break
                        }
                    }
                    
                    // Check again if the task has executed
                    if (!taskExecuted.get()) {
                        Log.d(TAG, "Task is still not executed after ${timeout}ms")
                        // The main thread is blocked - record once per blocked period.
                        if (!anrInProgress.get()) {
                            anrInProgress.set(true)
                            handleAnrDetected()
                        }
                    }
                }
                
                // Calculate total time spent in this cycle
                val cycleTime = System.currentTimeMillis() - startTime
                
                // Wait before next check cycle to maintain timeout second intervals
                val timeToNextCheck = timeout - cycleTime
                if (timeToNextCheck > 0) {
                    sleep(timeToNextCheck)
                    
                    // One final check if we should exit
                    if (!isRunning.get() || isInterrupted) {
                        Log.d(TAG, "Tracking interrupted or stopped during between-cycle wait")
                        break
                    }
                }
            } catch (e: InterruptedException) {
                // Check if this was due to a deliberate stopTracking call
                if (!isRunning.get()) {
                    Log.d(TAG, "Tracking thread interrupted during normal shutdown")
                } else {
                    Log.w(TAG, "Tracking unexpectedly interrupted", e)
                }
                currentThread().interrupt()
                return
            }
        }
        
        Log.d(TAG, "Tracking stopped")
    }
    
    /**
     * Stop the ANR tracker
     */
    fun stopTracking() {
        Log.d(TAG, "stopTracking called - shutting down tracker")
        
        // First set the running flag to false before interrupting
        isRunning.set(false)
        
        // Remove any pending tasks on the main handler
        mainHandler.removeCallbacks(checkTask)
        
        // Now interrupt the thread
        interrupt()
        
        Log.d(TAG, "Tracker shutdown complete")
    }
    
    /**
     * Handle ANR detection by capturing stack trace and storing information
     */
    private fun handleAnrDetected() {
        try {
            // Get the main thread's stack trace
            val stackTrace = mainThread.stackTrace
            
            // Build a readable stack trace
            // Match Android Log.getStackTraceString / ApplicationExitInfo format so
            // ingest R8 retrace and parseAndroidCrashTrace can consume the text.
            val stackTraceStr = StringBuilder()
            for (element in stackTrace) {
                stackTraceStr.append("    at ")
                    .append(element.className)
                    .append(".")
                    .append(element.methodName)
                    .append("(")
                    .append(element.fileName)
                    .append(":")
                    .append(element.lineNumber)
                    .append(")\n")
            }
            
            // Create JSON object with ANR information
            val anrInfo = JSONObject().apply {
                put("type", "ANR")
                put("timestamp", System.currentTimeMillis())
                put("stacktrace", stackTraceStr.toString())
                put("duration", timeout)
                put("source", "ANRTracker")
            }
            
            val payload = anrInfo.toString()

            // Persist first: survives process kill before JS/network can run.
            applicationContext?.let { context ->
                FaroAnrCache.savePendingAnr(context, payload)
            }

            synchronized(anrListLock) {
                anrList.add(payload)
            }

            onAnrDetected?.invoke(payload)
            
            Log.w(TAG, "ANR detected: $stackTraceStr")
        } catch (e: Exception) {
            Log.e(TAG, "Error handling ANR", e)
        }
    }
}
