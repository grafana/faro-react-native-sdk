package com.grafana.faro.reactnative

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File
import java.lang.ref.WeakReference

/** Process identity and single-writer ownership for persisted session state. */
internal object FaroSessionProcess {
    private val persistenceLock = Any()
    private var persistenceOwner: WeakReference<Any>? = null

    fun identifier(): String? =
        identifier(
            sdkInt = Build.VERSION.SDK_INT,
            currentProcessName = { Application.getProcessName() },
            legacyProcessName = { File("/proc/self/cmdline").readText() },
        )

    internal fun identifier(
        sdkInt: Int,
        currentProcessName: () -> String?,
        legacyProcessName: () -> String?,
    ): String? {
        val currentName = try {
            if (sdkInt >= Build.VERSION_CODES.P) {
                currentProcessName()
            } else {
                legacyProcessName()?.substringBefore('\u0000')
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

    fun claimPersistence(owner: Any): Boolean =
        synchronized(persistenceLock) {
            val currentOwner = persistenceOwner?.get()
            if (currentOwner != null && currentOwner !== owner) {
                false
            } else {
                persistenceOwner = WeakReference(owner)
                true
            }
        }

    fun releasePersistence(owner: Any): Boolean =
        synchronized(persistenceLock) {
            if (persistenceOwner?.get() !== owner) {
                false
            } else {
                persistenceOwner = null
                true
            }
        }

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
        synchronized(persistenceLock) {
            persistenceOwner = null
        }
    }
}
