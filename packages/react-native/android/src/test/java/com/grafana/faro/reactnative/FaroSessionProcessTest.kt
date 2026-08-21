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
    fun identifier_usesThePlatformApiOnAndroidPAndNewer() {
        assertEquals(
            "com.example.app:worker",
            FaroSessionProcess.identifier(
                sdkInt = 28,
                currentProcessName = { "com.example.app:worker" },
                legacyProcessName = { error("legacy lookup should not run") },
            ),
        )
    }

    @Test
    fun identifier_readsTheNullTerminatedCmdlineBeforeAndroidP() {
        assertEquals(
            "com.example.app:worker",
            FaroSessionProcess.identifier(
                sdkInt = 27,
                currentProcessName = { error("platform lookup should not run") },
                legacyProcessName = { "com.example.app:worker\u0000ignored" },
            ),
        )
    }

    @Test
    fun identifier_failsClosedWhenTheProcessNameCannotBeRead() {
        assertNull(
            FaroSessionProcess.identifier(
                sdkInt = 27,
                currentProcessName = { error("platform lookup should not run") },
                legacyProcessName = { throw IllegalStateException("unavailable") },
            ),
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
    fun claimPersistence_allowsOnlyOneOwnerAtATime() {
        val firstOwner = Any()
        val secondOwner = Any()

        assertTrue(FaroSessionProcess.claimPersistence(firstOwner))
        assertTrue(FaroSessionProcess.claimPersistence(firstOwner))
        assertFalse(FaroSessionProcess.claimPersistence(secondOwner))
        assertFalse(FaroSessionProcess.releasePersistence(secondOwner))
        assertTrue(FaroSessionProcess.releasePersistence(firstOwner))
        assertTrue(FaroSessionProcess.claimPersistence(secondOwner))
    }
}
