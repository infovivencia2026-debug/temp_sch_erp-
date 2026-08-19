package com.schoolerp.smsgateway.service

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.data.prefs.TokenStore
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * The safety net, not the mechanism.
 *
 * All the real work happens in [GatewayService]. This exists because a
 * foreground service is not actually immortal: an OEM task killer, a low-memory
 * kill, or a background-start refusal on Android 12+ can all leave the phone
 * looking paired and doing nothing. WorkManager survives all three, so every
 * fifteen minutes it checks and restarts.
 *
 * It also flushes receipts itself. If the service cannot be started at all,
 * the least this app can do is stop the server re-sending messages that already
 * went out.
 */
@HiltWorker
class GatewayRestartWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val tokenStore: TokenStore,
    private val repository: GatewayRepository,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (tokenStore.token() == null) {
            GwLog.d("worker", "not paired; nothing to keep alive")
            return Result.success()
        }

        // Cheap and idempotent: starting an already-running service just
        // delivers another onStartCommand.
        GatewayServiceLauncher.start(applicationContext)

        return try {
            repository.flushReceipts()
            Result.success()
        } catch (error: Exception) {
            GwLog.w("worker", "receipt flush failed", error)
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "gateway-keepalive"

        /**
         * Fifteen minutes is WorkManager's floor for periodic work, and it is
         * fine: the service is expected to be running, and this only has to
         * notice that it is not.
         */
        fun enqueuePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<GatewayRestartWorker>(15, TimeUnit.MINUTES)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
        }
    }
}
