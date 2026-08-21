package com.grafana.faro.reactnative

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FaroSessionProcessTest {

    @Before
    fun setUp() {
        FaroSessionProcess.resetPersistenceClaimForTest()
    }

    @After
    fun tearDown() {
        FaroSessionProcess.resetPersistenceClaimForTest()
    }

    @Test
    fun normalizeIdentifier_rejectsMissingProcessNames() {
        assertNull(FaroSessionProcess.normalizeIdentifier(null))
        assertNull(FaroSessionProcess.normalizeIdentifier("   "))
    }

    @Test
    fun normalizeIdentifier_trimsKnownProcessName() {
        assertEquals(
            "com.example.app:worker",
            FaroSessionProcess.normalizeIdentifier("  com.example.app:worker  "),
        )
    }

    @Test
    fun isMainProcess_comparesCurrentProcessWithDeclaredMainProcess() {
        assertEquals(
            true,
            FaroSessionProcess.isMainProcess(
                currentName = "com.example.app",
                declaredMainName = "com.example.app",
                packageName = "com.example.app",
            ),
        )
        assertEquals(
            false,
            FaroSessionProcess.isMainProcess(
                currentName = "com.example.app:worker",
                declaredMainName = "com.example.app",
                packageName = "com.example.app",
            ),
        )
    }

    @Test
    fun isMainProcess_usesPackageNameWhenMainProcessIsNotDeclared() {
        assertEquals(
            true,
            FaroSessionProcess.isMainProcess(
                currentName = "com.example.app",
                declaredMainName = " ",
                packageName = "com.example.app",
            ),
        )
    }

    @Test
    fun isMainProcess_failsClosedWithoutCurrentIdentity() {
        assertNull(
            FaroSessionProcess.isMainProcess(
                currentName = null,
                declaredMainName = "com.example.app",
                packageName = "com.example.app",
            ),
        )
    }

    @Test
    fun claimPersistence_allowsOnlyTheFirstRuntimeInThisProcess() {
        assertTrue(FaroSessionProcess.claimPersistence())
        assertFalse(FaroSessionProcess.claimPersistence())
    }
}
