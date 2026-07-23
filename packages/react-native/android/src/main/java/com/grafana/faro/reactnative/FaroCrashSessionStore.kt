package com.grafana.faro.reactnative

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists the minimum process/session context needed to associate a historical
 * ApplicationExitInfo crash with the Faro session that was active before process death.
 */
internal object FaroCrashSessionStore {
    internal const val MAX_CONTEXT_AGE_MS = 7L * 24L * 60L * 60L * 1000L

    private const val PREFS_NAME = "com.grafana.faro.crash_session_store"
    private const val KEY_SESSION_CONTEXTS = "session_contexts"
    private const val KEY_PENDING_REPORTS = "pending_reports"
    private const val KEY_ACKNOWLEDGED_REPORTS = "acknowledged_reports"
    private const val MAX_SESSION_CONTEXTS = 100
    private const val MAX_PENDING_REPORTS = 50
    private const val MAX_ACKNOWLEDGED_REPORTS = 100
    private const val SCHEMA_VERSION = 1

    data class SessionContext(
        val id: String,
        val sessionId: String,
        val activatedAtMs: Long,
        val updatedAtMs: Long,
        val pid: Int,
        val processName: String,
        val isSampled: Boolean?,
        val appVersion: String?,
        val appRelease: String?,
        val appBundleId: String?,
    )

    private data class PendingReport(
        val reportId: String,
        val contextId: String?,
        val crashTimestampMs: Long,
        val usesPendingTrace: Boolean,
    )

    private data class AcknowledgedReport(
        val reportId: String,
        val acknowledgedAtMs: Long,
    )

    private data class State(
        val contexts: MutableList<SessionContext>,
        val pendingReports: MutableList<PendingReport>,
        val acknowledgedReports: MutableList<AcknowledgedReport>,
    )

    data class AcknowledgeResult(
        val persisted: Boolean,
        val clearPendingTrace: Boolean,
    )

    @Synchronized
    fun recordSessionContext(
        context: Context,
        sessionId: String,
        activatedAtMs: Long,
        isSampled: Boolean?,
        appVersion: String?,
        appRelease: String?,
        appBundleId: String?,
        nowMs: Long = System.currentTimeMillis(),
        pid: Int = Process.myPid(),
        processName: String = currentProcessName(context.applicationContext),
    ): Boolean {
        val normalizedSessionId = sessionId.trim()
        if (normalizedSessionId.isEmpty() || activatedAtMs <= 0L) {
            return false
        }

        val appContext = context.applicationContext
        val normalizedProcessName = processName.trim()
        if (pid <= 0 || normalizedProcessName.isEmpty()) {
            return false
        }
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val state = readState(prefs, nowMs)
        val existingIndex = state.contexts.indexOfFirst {
            it.sessionId == normalizedSessionId &&
                it.pid == pid &&
                it.processName == normalizedProcessName
        }

        val existing = state.contexts.getOrNull(existingIndex)
        val firstActivation = existing?.activatedAtMs ?: activatedAtMs
        val sessionContext = SessionContext(
            id = existing?.id ?: FaroCrashIds.sessionContextId(
                normalizedSessionId,
                firstActivation,
                pid,
                normalizedProcessName,
            ),
            sessionId = normalizedSessionId,
            activatedAtMs = firstActivation,
            updatedAtMs = nowMs,
            pid = pid,
            processName = normalizedProcessName,
            isSampled = isSampled,
            appVersion = appVersion.normalized(),
            appRelease = appRelease.normalized(),
            appBundleId = appBundleId.normalized(),
        )

        if (existingIndex >= 0) {
            state.contexts[existingIndex] = sessionContext
        } else {
            state.contexts.add(sessionContext)
        }

        state.contexts.sortBy { it.activatedAtMs }
        trimSessionContexts(state)
        return writeState(prefs, state)
    }

    @Synchronized
    fun findMatchingContext(
        context: Context,
        crashTimestampMs: Long,
        pid: Int,
        processName: String,
        nowMs: Long = System.currentTimeMillis(),
    ): SessionContext? {
        if (crashTimestampMs <= 0L) {
            return null
        }

        val normalizedProcessName = processName.trim()
        if (pid <= 0 && normalizedProcessName.isEmpty()) {
            return null
        }

        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return readState(prefs, nowMs).contexts
            .asSequence()
            .filter { it.activatedAtMs <= crashTimestampMs }
            .filter { pid <= 0 || it.pid == pid }
            .filter { normalizedProcessName.isEmpty() || it.processName == normalizedProcessName }
            .maxByOrNull { it.activatedAtMs }
    }

    @Synchronized
    fun contextForPendingReport(
        context: Context,
        reportId: String,
        nowMs: Long = System.currentTimeMillis(),
    ): SessionContext? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val state = readState(prefs, nowMs)
        val contextId = state.pendingReports.firstOrNull { it.reportId == reportId }?.contextId ?: return null
        return state.contexts.firstOrNull { it.id == contextId }
    }

    @Synchronized
    fun rememberPendingReport(
        context: Context,
        reportId: String,
        crashTimestampMs: Long,
        sessionContext: SessionContext?,
        usesPendingTrace: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        if (reportId.isBlank() || crashTimestampMs <= 0L) {
            return
        }

        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val state = readState(prefs, nowMs)
        val existingIndex = state.pendingReports.indexOfFirst { it.reportId == reportId }
        val existing = state.pendingReports.getOrNull(existingIndex)
        val pendingReport = PendingReport(
            reportId = reportId,
            contextId = existing?.contextId ?: sessionContext?.id,
            crashTimestampMs = crashTimestampMs,
            usesPendingTrace = existing?.usesPendingTrace == true || usesPendingTrace,
        )

        if (existingIndex >= 0) {
            state.pendingReports[existingIndex] = pendingReport
        } else {
            state.pendingReports.add(pendingReport)
        }

        state.pendingReports.sortBy { it.crashTimestampMs }
        trimOldest(state.pendingReports, MAX_PENDING_REPORTS)
        writeState(prefs, state)
    }

    @Synchronized
    fun isReportAcknowledged(
        context: Context,
        reportId: String,
        nowMs: Long = System.currentTimeMillis(),
    ): Boolean {
        if (reportId.isBlank()) {
            return false
        }
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return readState(prefs, nowMs).acknowledgedReports.any { it.reportId == reportId }
    }

    @Synchronized
    fun acknowledgeReports(
        context: Context,
        reportIds: Collection<String>,
        nowMs: Long = System.currentTimeMillis(),
    ): AcknowledgeResult {
        val normalizedIds = reportIds.map(String::trim).filter(String::isNotEmpty).toSet()
        if (normalizedIds.isEmpty()) {
            return AcknowledgeResult(persisted = true, clearPendingTrace = false)
        }

        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val state = readState(prefs, nowMs)
        val acknowledgedMappings = state.pendingReports.filter { it.reportId in normalizedIds }
        val contextIds = acknowledgedMappings.mapNotNull { it.contextId }.toSet()
        val acknowledgedPendingTrace = acknowledgedMappings.any { it.usesPendingTrace }

        state.pendingReports.removeAll { it.reportId in normalizedIds }
        val remainingContextIds = state.pendingReports.mapNotNullTo(mutableSetOf()) { it.contextId }
        state.contexts.removeAll { it.id in contextIds && it.id !in remainingContextIds }
        val clearPendingTrace = acknowledgedPendingTrace && state.pendingReports.none { it.usesPendingTrace }

        state.acknowledgedReports.removeAll { it.reportId in normalizedIds }
        normalizedIds.forEach { reportId ->
            state.acknowledgedReports.add(AcknowledgedReport(reportId, nowMs))
        }
        trimOldest(state.acknowledgedReports, MAX_ACKNOWLEDGED_REPORTS)
        val persisted = writeState(prefs, state)

        return AcknowledgeResult(
            persisted = persisted,
            clearPendingTrace = persisted && clearPendingTrace,
        )
    }

    @Synchronized
    internal fun sessionContextsForTest(
        context: Context,
        nowMs: Long,
    ): List<SessionContext> {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return readState(prefs, nowMs).contexts
    }

    private fun currentProcessName(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val processName = Application.getProcessName().trim()
            if (processName.isNotEmpty()) {
                return processName
            }
        }
        return context.applicationInfo.processName.orEmpty().ifBlank { context.packageName }
    }

    private fun readState(
        prefs: android.content.SharedPreferences,
        nowMs: Long,
    ): State {
        val cutoff = nowMs - MAX_CONTEXT_AGE_MS
        val contexts = readArray(prefs, KEY_SESSION_CONTEXTS)
            .mapNotNull(::sessionContextFromJson)
            .filterTo(mutableListOf()) { it.updatedAtMs >= cutoff }
        val pendingReports = readArray(prefs, KEY_PENDING_REPORTS)
            .mapNotNull(::pendingReportFromJson)
            .filterTo(mutableListOf()) { it.crashTimestampMs >= cutoff }
        val acknowledgedReports = readArray(prefs, KEY_ACKNOWLEDGED_REPORTS)
            .mapNotNull(::acknowledgedReportFromJson)
            .filterTo(mutableListOf()) { it.acknowledgedAtMs >= cutoff }

        return State(contexts, pendingReports, acknowledgedReports)
    }

    private fun writeState(
        prefs: android.content.SharedPreferences,
        state: State,
    ): Boolean {
        return prefs.edit()
            .putString(KEY_SESSION_CONTEXTS, JSONArray(state.contexts.map(::sessionContextToJson)).toString())
            .putString(KEY_PENDING_REPORTS, JSONArray(state.pendingReports.map(::pendingReportToJson)).toString())
            .putString(
                KEY_ACKNOWLEDGED_REPORTS,
                JSONArray(state.acknowledgedReports.map(::acknowledgedReportToJson)).toString(),
            )
            .commit()
    }

    private fun readArray(
        prefs: android.content.SharedPreferences,
        key: String,
    ): List<JSONObject> {
        val array = try {
            JSONArray(prefs.getString(key, "[]") ?: "[]")
        } catch (_: Exception) {
            JSONArray()
        }

        return buildList {
            for (index in 0 until array.length()) {
                array.optJSONObject(index)?.let(::add)
            }
        }
    }

    private fun sessionContextToJson(context: SessionContext): JSONObject {
        return JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("id", context.id)
            .put("sessionId", context.sessionId)
            .put("activatedAt", context.activatedAtMs)
            .put("updatedAt", context.updatedAtMs)
            .put("pid", context.pid)
            .put("processName", context.processName)
            .putOptional("isSampled", context.isSampled)
            .putOptional("appVersion", context.appVersion)
            .putOptional("appRelease", context.appRelease)
            .putOptional("appBundleId", context.appBundleId)
    }

    private fun sessionContextFromJson(json: JSONObject): SessionContext? {
        if (json.optInt("schemaVersion", 0) != SCHEMA_VERSION) {
            return null
        }

        val id = json.optString("id").trim()
        val sessionId = json.optString("sessionId").trim()
        val activatedAtMs = json.optLong("activatedAt", 0L)
        val updatedAtMs = json.optLong("updatedAt", activatedAtMs)
        val pid = json.optInt("pid", 0)
        val processName = json.optString("processName").trim()
        if (
            id.isEmpty() ||
            sessionId.isEmpty() ||
            activatedAtMs <= 0L ||
            updatedAtMs <= 0L ||
            pid <= 0 ||
            processName.isEmpty()
        ) {
            return null
        }

        return SessionContext(
            id = id,
            sessionId = sessionId,
            activatedAtMs = activatedAtMs,
            updatedAtMs = updatedAtMs,
            pid = pid,
            processName = processName,
            isSampled = json.optionalBoolean("isSampled"),
            appVersion = json.optionalString("appVersion"),
            appRelease = json.optionalString("appRelease"),
            appBundleId = json.optionalString("appBundleId"),
        )
    }

    private fun pendingReportToJson(report: PendingReport): JSONObject {
        return JSONObject()
            .put("reportId", report.reportId)
            .putOptional("contextId", report.contextId)
            .put("crashTimestamp", report.crashTimestampMs)
            .put("usesPendingTrace", report.usesPendingTrace)
    }

    private fun pendingReportFromJson(json: JSONObject): PendingReport? {
        val reportId = json.optString("reportId").trim()
        val crashTimestampMs = json.optLong("crashTimestamp", 0L)
        if (reportId.isEmpty() || crashTimestampMs <= 0L) {
            return null
        }
        return PendingReport(
            reportId = reportId,
            contextId = json.optionalString("contextId"),
            crashTimestampMs = crashTimestampMs,
            usesPendingTrace = json.optBoolean("usesPendingTrace", false),
        )
    }

    private fun acknowledgedReportToJson(report: AcknowledgedReport): JSONObject {
        return JSONObject()
            .put("reportId", report.reportId)
            .put("acknowledgedAt", report.acknowledgedAtMs)
    }

    private fun acknowledgedReportFromJson(json: JSONObject): AcknowledgedReport? {
        val reportId = json.optString("reportId").trim()
        val acknowledgedAtMs = json.optLong("acknowledgedAt", 0L)
        if (reportId.isEmpty() || acknowledgedAtMs <= 0L) {
            return null
        }
        return AcknowledgedReport(reportId, acknowledgedAtMs)
    }

    private fun JSONObject.putOptional(key: String, value: Any?): JSONObject {
        if (value != null) {
            put(key, value)
        }
        return this
    }

    private fun JSONObject.optionalString(key: String): String? {
        if (!has(key) || isNull(key)) {
            return null
        }
        return optString(key).normalized()
    }

    private fun JSONObject.optionalBoolean(key: String): Boolean? {
        if (!has(key) || isNull(key)) {
            return null
        }
        return optBoolean(key)
    }

    private fun String?.normalized(): String? {
        return this?.trim()?.takeIf(String::isNotEmpty)
    }

    private fun trimSessionContexts(state: State) {
        val referencedContextIds = state.pendingReports.mapNotNullTo(mutableSetOf()) { it.contextId }
        while (state.contexts.size > MAX_SESSION_CONTEXTS) {
            val removableIndex = state.contexts.indexOfFirst { it.id !in referencedContextIds }
            state.contexts.removeAt(if (removableIndex >= 0) removableIndex else 0)
        }
    }

    private fun <T> trimOldest(items: MutableList<T>, maximumSize: Int) {
        while (items.size > maximumSize) {
            items.removeAt(0)
        }
    }
}
