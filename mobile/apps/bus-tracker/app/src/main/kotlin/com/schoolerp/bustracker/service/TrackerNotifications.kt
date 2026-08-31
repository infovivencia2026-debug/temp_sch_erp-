package com.schoolerp.bustracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.schoolerp.bustracker.MainActivity
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.engine.TrackerStatus
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The permanent notice is not decoration — it is the price of collecting
 * location in the background, and Android requires it to be there for as long
 * as the run is. It doubles as the one place a driver glancing at a dashboard
 * can see that the bus is actually on the school's map, so it says which bus,
 * which run, and what is wrong when something is.
 */
@Singleton
class TrackerNotifications @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    private val manager: NotificationManager? =
        context.getSystemService(NotificationManager::class.java)

    fun ensureChannels() {
        val run = NotificationChannel(
            CHANNEL_RUN,
            context.getString(R.string.notification_channel_run),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_run_desc)
            setShowBadge(false)
        }
        val problem = NotificationChannel(
            CHANNEL_PROBLEM,
            context.getString(R.string.notification_channel_problem),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_problem_desc)
        }
        manager?.createNotificationChannel(run)
        manager?.createNotificationChannel(problem)
    }

    fun ongoing(status: TrackerStatus?): Notification {
        val bus = status?.vehicleRegistration
        val title = when {
            bus != null && status.trip != null -> "$bus, ${directionWord(status.trip.direction)}"
            bus != null -> bus
            else -> "School bus tracker"
        }
        return NotificationCompat.Builder(context, CHANNEL_RUN)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(status?.summary ?: "Starting…")
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail(status)))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openApp())
            .build()
    }

    /**
     * Raised on the high-importance channel, because these are the two things
     * the driver has to notice while driving: the school has closed the run, or
     * the phone has stopped being able to report at all.
     */
    fun problem(headline: String, detail: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_PROBLEM)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(headline)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp())
            .build()
        manager?.notify(PROBLEM_ID, notification)
    }

    fun update(status: TrackerStatus) {
        manager?.notify(ONGOING_ID, ongoing(status))
    }

    private fun detail(status: TrackerStatus?): String {
        if (status == null) return "Starting…"
        status.locationBlocker?.let { return "${it.headline}. ${it.detail}" }
        val trip = status.trip ?: return "No run open. The school cannot see this bus."
        return buildString {
            append("${trip.routeName.ifBlank { "Route" }}, ${directionWord(trip.direction)}. ")
            append(status.summary)
            if (!status.hasNetwork) append(". Nothing is lost, it is being held until there is signal")
        }
    }

    private fun directionWord(direction: String): String =
        if (direction == com.schoolerp.bustracker.data.prefs.DIRECTION_DROP) "drop" else "pickup"

    private fun openApp(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val CHANNEL_RUN = "tracker_run"
        const val CHANNEL_PROBLEM = "tracker_problem"
        const val ONGOING_ID = 2001
        const val PROBLEM_ID = 2002
    }
}
