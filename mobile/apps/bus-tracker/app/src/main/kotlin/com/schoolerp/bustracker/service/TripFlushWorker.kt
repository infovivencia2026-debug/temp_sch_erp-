package com.schoolerp.bustracker.service

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.prefs.TokenStore
import com.schoolerp.bustracker.data.repo.TrackerRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.flow.first
import java.util.concurrent.TimeUnit

/**
 * The safety net, not the mechanism.
 *
 * All the real work happens in [TrackerService]. This exists because a
 * foreground service is not actually immortal: an OEM task killer, a low-memory
 * kill on a cheap handset, or a refused background start can each leave a phone
 * that looks like it is on a run and is reporting nothing. WorkManager survives
 * all three.
 *
 * It also flushes the buffer itself, which is the part that matters most. If
 * the service cannot be brought back at all, the least this app owes the school
 * is the history it already has on disk — a route uploaded late is still the
 * route the bus took.
 */
@HiltWorker
class TripFlushWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val tokenStore: TokenStore,
    private val settingsStore: SettingsStore,
    private val repository: TrackerRepository,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (tokenStore.token() == null) {
            BtLog.d("worker", "not paired; nothing to keep alive")
            return Result.success()
        }

        val trip = settingsStore.settings.first().activeTrip
        if (trip == null) {
            // No run open: the service is supposed to be stopped, so do not
            // start it. Starting a location service with no trip would be
            // tracking a driver's own evening, which this app must never do.
            repository.heartbeat()
            return Result.success()
        }

        // Cheap and idempotent: starting an already-running service just
        // delivers another onStartCommand.
        TrackerServiceLauncher.start(applicationContext)

        return try {
            repository.flushBuffer(trip.tripId)
            repository.heartbeat()
            Result.success()
        } catch (error: Exception) {
            BtLog.w("worker", "flush failed", error)
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "tracker-keepalive"
        private const val ONCE_NAME = "tracker-resume-now"

        /**
         * Fifteen minutes is WorkManager's floor for periodic work, and it is
         * fine: the service is expected to be doing the work, and this only has
         * to notice that it is not.
         */
        fun enqueuePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<TripFlushWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        /**
         * A one-off run now. Used after a boot: waiting up to fifteen minutes
         * for the first periodic tick would mean a bus missing from the map for
         * a quarter of its route.
         */
        fun enqueueOnce(context: Context) {
            val request = OneTimeWorkRequestBuilder<TripFlushWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONCE_NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
            WorkManager.getInstance(context).cancelUniqueWork(ONCE_NAME)
        }
    }
}
