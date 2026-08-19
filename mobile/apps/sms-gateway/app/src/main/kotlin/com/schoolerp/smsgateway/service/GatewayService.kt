package com.schoolerp.smsgateway.service

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.engine.EngineSignals
import com.schoolerp.smsgateway.engine.GatewayEngine
import com.schoolerp.smsgateway.engine.StatusAggregator
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
 * The process that actually does the work, kept alive by a foreground
 * notification.
 *
 * Android will kill a plain background poller within minutes, and Doze will
 * suspend it long before that. A foreground service with a visible, persistent
 * notification is the only arrangement in which a phone in an office drawer
 * still answers the server at four in the afternoon. [GatewayRestartWorker] is
 * the belt to this service's braces: if the process is killed anyway, or if a
 * background start was refused, WorkManager brings it back.
 */
@AndroidEntryPoint
class GatewayService : Service() {

    @Inject lateinit var engine: GatewayEngine

    @Inject lateinit var aggregator: StatusAggregator

    @Inject lateinit var notifications: GatewayNotifications

    @Inject lateinit var signals: EngineSignals

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var engineJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        notifications.ensureChannels()
        // Within a few seconds of onCreate or Android kills the process, so the
        // first notification goes up before anything else is attempted.
        promoteToForeground()
        signals.publishServiceRunning(true)

        scope.launch {
            aggregator.status.distinctUntilChanged { old, new ->
                old.summary == new.summary && old.institutionName == new.institutionName
            }.collect { notifications.update(it) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            GwLog.i("service", "stopping on operator request")
            stopSelf()
            return START_NOT_STICKY
        }

        if (engineJob?.isActive != true) {
            GwLog.i("service", "starting gateway loops")
            engineJob = scope.launch { engine.run() }
        }

        // STICKY, not REDELIVER: there is no intent worth redelivering, and the
        // work to resume is all in the database.
        return START_STICKY
    }

    override fun onDestroy() {
        GwLog.i("service", "stopping")
        signals.publishServiceRunning(false)
        scope.cancel()
        // Anything that killed us — low memory, a swipe, an OEM task killer —
        // is exactly when the safety net has to fire.
        GatewayRestartWorker.enqueuePeriodic(applicationContext)
        super.onDestroy()
    }

    private fun promoteToForeground() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, GatewayNotifications.ONGOING_ID, notifications.ongoing(null), type)
        } catch (error: Exception) {
            // Android 12+ refuses a foreground start from the background. The
            // worker will retry from a context where it is allowed.
            GwLog.e("service", "could not go foreground", error)
            GatewayRestartWorker.enqueuePeriodic(applicationContext)
            stopSelf()
        }
    }

    companion object {
        const val ACTION_STOP = "com.schoolerp.smsgateway.STOP_SERVICE"
    }
}
