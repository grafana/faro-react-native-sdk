package com.grafana.faro.reactnative

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [29])
class FaroCrashReporterBelowApi30Test {

    @Test
    fun getCrashReports_isNoOpBeforeApi30() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        assertNull(FaroCrashReporter.getCrashReports(context))
    }
}
