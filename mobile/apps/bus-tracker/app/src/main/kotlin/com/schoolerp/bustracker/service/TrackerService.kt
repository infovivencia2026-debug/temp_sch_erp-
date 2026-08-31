package com.schoolerp.bustracker.service

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.device.LocationPermissions
import com.schoolerp.bustracker.engine.EngineEvent
import com.schoolerp.bustracker.engine.StatusAggregator
import com.schoolerp.bustracker.engine.TripEngine
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The process that keeps the bus on the map, kept alive by a foreground
 * notification, and alive only while a run is open.
 *
 * `foregroundServiceType="location"` is the load-bearing detail. From Android
 * 10 the OS stops delivering fixes to an app that is not visible unless it is
 * running a foreground service typed for location; from Android 14 starting a
 * typed service without the matching `FOREGROUND_SERVICE_LOCATION` permission
 * throws outright. Typing it `dataSync` instead — which would compile and run —
 * would earn a roughly six-hour daily cap on Android 15 and would still not
 * license the background fixes. A run is not tracked; the notification says it
 * is.
 */
@AndroidEntryPoint
class TrackerService : Service() {

    @Inject lateinit var engine: TripEngine

    @Inject lateinit var aggregator: StatusAggregator

    @Inject lateinit var notifications: TrackerNotifications

    @Inject lateinit var permissions: LocationPermissions

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var engineJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        notifications.ensureChannels()
        // Within a few seconds of onCreate or Android kills the process, so the
        // first notification goes up before anything else is attempted.
        promoteToForeground()
        engine.publishServiceRunning(true)

        scope.launch {
            aggregator.status.distinctUntilChanged { old, new ->
                old.summary == new.summary && old.vehicleRegistration == new.vehicleRegistration
            }.collect { notifications.update(it) }
        }

        scope.launch {
            engine.events.collect { event -> announce(event) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            BtLog.i("service", "stopping on driver request")
            stopSelf()
            return START_NOT_STICKY
        }

        if (engineJob?.isActive != true) {
            BtLog.i("service", "starting tracking loops")
            engineJob = scope.launch { engine.run() }
        }

        // STICKY, not REDELIVER: there is no intent worth redelivering, and the
        // run to resume is on disk in the settings store.
        return START_STICKY
    }

    override fun onDestroy() {
        BtLog.i("service", "stopping")
        engine.publishServiceRunning(false)
        scope.cancel()
        // Whatever killed us — low memory, an OEM task killer, a swipe from
        // recents — is exactly when the safety net has to fire.
        TripFlushWorker.enqueuePeriodic(applicationContext)
        super.onDestroy()
    }

    private fun announce(event: EngineEvent) {
        when (event) {
            is EngineEvent.TripClosedByServer -> {
                notifications.problem(
                    "The school closed this run",
                    "This phone has stopped reporting. If the run is still going, start it " +
                        "again from the app.",
                )
                // The run is over as far as the server is concerned, so there is
                // nothing left for this service to do and no reason to keep
                // holding a location permission open.
                stopSelf()
            }
            is EngineEvent.ClockWrong -> notifications.problem(
                "This phone's clock is wrong",
                "The school's server says the time is ${event.serverTime ?: "different"}. " +
                    "Fixes cannot be recorded until the phone's date and time are corrected.",
            )
            is EngineEvent.Unpaired -> {
                notifications.problem(
                    "This phone has stopped reporting",
                    "The school's server no longer accepts it. Open the app and sign in again " +
                        "with your number and password.",
                )
                stopSelf()
            }
            is EngineEvent.StopReached -> Unit
        }
    }

    private fun promoteToForeground() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, TrackerNotifications.ONGOING_ID, notifications.ongoing(null), type)
        } catch (error: Exception) {
            // Two real causes, and both end the same way. Android 12+ refuses a
            // foreground start from the background; Android 14+ refuses a
            // location-typed service outright when the location permission is
            // not held. Neither can be argued with here, so the service stops
            // and the driver is told rather than left with an app that looks
            // like it is running.
            BtLog.e("service", "could not go foreground", error)
            if (!permissions.hasFine()) {
                notifications.problem(
                    "Location permission is missing",
                    "Android will not let this app track the bus without it. Open the app and " +
                        "grant location, then start the run again.",
                )
            }
            TripFlushWorker.enqueuePeriodic(applicationContext)
            stopSelf()
        }
    }

    companion object {
        const val ACTION_STOP = "com.schoolerp.bustracker.STOP_SERVICE"
    }
}
