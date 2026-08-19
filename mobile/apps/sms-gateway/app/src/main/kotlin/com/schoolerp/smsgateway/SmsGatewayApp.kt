package com.schoolerp.smsgateway

import android.app.Application
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.schoolerp.smsgateway.data.prefs.TokenStore
import com.schoolerp.smsgateway.service.GatewayNotifications
import com.schoolerp.smsgateway.service.GatewayRestartWorker
import com.schoolerp.smsgateway.service.GatewayServiceLauncher
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class SmsGatewayApp : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory

    @Inject lateinit var notifications: GatewayNotifications

    @Inject lateinit var tokenStore: TokenStore

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        notifications.ensureChannels()

        // The safety net is scheduled whether or not the service starts now: it
        // is what recovers a phone whose service was killed while nobody was
        // looking at it.
        GatewayRestartWorker.enqueuePeriodic(this)

        if (tokenStore.token() != null) {
            GatewayServiceLauncher.start(this)
        }
    }
}
