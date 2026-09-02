package com.schoolerp.smsgateway.service

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.schoolerp.smsgateway.core.GwLog

/** One place that knows how to start and stop the gateway, and how it fails. */
object GatewayServiceLauncher {

    fun start(context: Context) {
        val intent = Intent(context, GatewayService::class.java)
        try {
            ContextCompat.startForegroundService(context, intent)
        } catch (error: Exception) {
            // On Android 12+ this throws if the app is in the background with
            // no exemption. Not fatal — the periodic worker runs in a context
            // where the start is allowed.
            GwLog.w("service", "foreground start refused; leaving it to the worker", error)
        }
        GatewayRestartWorker.enqueuePeriodic(context)
    }

    /** Deliberate operator stop: the worker is cancelled too, or it would undo it. */
    fun stop(context: Context) {
        GatewayRestartWorker.cancel(context)
        try {
            context.startService(Intent(context, GatewayService::class.java).setAction(GatewayService.ACTION_STOP))
        } catch (error: Exception) {
            // Android 8+ refuses a plain start from the background, and this
            // is reached from a ViewModel that may outlive the screen. A
            // service that is not running has nothing to stop anyway.
            GwLog.w("service", "stop intent refused", error)
        }
    }
}
