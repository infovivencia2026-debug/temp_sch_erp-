package com.schoolerp.bustracker

import android.app.Application
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.schoolerp.bustracker.data.prefs.TokenStore
import com.schoolerp.bustracker.service.TrackerNotifications
import com.schoolerp.bustracker.service.TripFlushWorker
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class BusTrackerApp : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory

    @Inject lateinit var notifications: TrackerNotifications

    @Inject lateinit var tokenStore: TokenStore

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        notifications.ensureChannels()

        // Note what does not happen here: the service is not started. Unlike the
        // SMS gateway, which should be running whenever the phone is on, this
        // app must collect nothing until a driver opens a run. The worker checks
        // for an interrupted run and resumes only that.
        if (tokenStore.token() != null) {
            TripFlushWorker.enqueuePeriodic(this)
        }
    }
}
