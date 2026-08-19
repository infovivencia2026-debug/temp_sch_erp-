package com.schoolerp.bustracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.data.prefs.TokenStore
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * A phone that rebooted mid-route must come back to the same run.
 *
 * `BOOT_COMPLETED` is one of the few remaining exemptions that permits starting
 * a foreground service from the background, which is exactly what is needed
 * here. `MY_PACKAGE_REPLACED` covers the other case: an app update stops the
 * service and nothing would otherwise restart it.
 *
 * The receiver deliberately does not start the service itself. Whether there is
 * a run to resume is a disk read, and a BroadcastReceiver has milliseconds; so
 * it schedules the worker, which checks and either resumes the run or does
 * nothing. A tracker that started itself on every boot regardless would be
 * following a driver home.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var tokenStore: TokenStore

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }
        if (tokenStore.token() == null) {
            BtLog.i("boot", "not paired; staying idle")
            return
        }
        BtLog.i("boot", "scheduling resume check after ${intent.action}")
        TripFlushWorker.enqueuePeriodic(context)
        // And once, now. Waiting up to fifteen minutes for the first periodic
        // tick would be a bus missing from the map for a quarter of its route.
        TripFlushWorker.enqueueOnce(context)
    }
}
