package com.schoolerp.bustracker.service

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.schoolerp.bustracker.core.BtLog

/** One place that knows how to start and stop the tracker, and how it fails. */
object TrackerServiceLauncher {

    fun start(context: Context) {
        val intent = Intent(context, TrackerService::class.java)
        try {
            ContextCompat.startForegroundService(context, intent)
        } catch (error: Exception) {
            // On Android 12+ this throws if the app is in the background with no
            // exemption. Not fatal: the flush worker runs in a context where the
            // start is allowed, and the buffer is on disk either way.
            BtLog.w("service", "foreground start refused; leaving it to the worker", error)
        }
        TripFlushWorker.enqueuePeriodic(context)
    }

    /** Deliberate stop: the worker goes too, or it would undo it. */
    fun stop(context: Context) {
        TripFlushWorker.cancel(context)
        context.startService(
            Intent(context, TrackerService::class.java).setAction(TrackerService.ACTION_STOP),
        )
    }
}
