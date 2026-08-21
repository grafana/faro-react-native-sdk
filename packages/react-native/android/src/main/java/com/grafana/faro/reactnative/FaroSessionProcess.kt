package com.grafana.faro.reactnative

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Process identity and single-writer ownership for persisted session state. */
internal object FaroSessionProcess {
    private val persistenceClaimed = AtomicBoolean(false)

    fun identifier(): String? {
        val currentName = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Application.getProcessName()
            } else {
                File("/proc/self/cmdline").readText().substringBefore('\u0000')
            }
        } catch (_: Exception) {
            null
        }

        return normalizeIdentifier(currentName)
    }

    fun isMainProcess(context: Context): Boolean? {
        return isMainProcess(
            currentName = identifier(),
            declaredMainName = context.applicationInfo.processName,
            packageName = context.packageName,
        )
    }

    fun claimPersistence(): Boolean = persistenceClaimed.compareAndSet(false, true)

    internal fun normalizeIdentifier(currentName: String?): String? =
        currentName?.trim()?.takeIf { it.isNotEmpty() }

    internal fun isMainProcess(
        currentName: String?,
        declaredMainName: String?,
        packageName: String?,
    ): Boolean? {
        val normalizedCurrentName = normalizeIdentifier(currentName) ?: return null
        val normalizedMainName = normalizeIdentifier(declaredMainName)
            ?: normalizeIdentifier(packageName)
            ?: return null
        return normalizedCurrentName == normalizedMainName
    }

    internal fun resetPersistenceClaimForTest() {
        persistenceClaimed.set(false)
    }
}
