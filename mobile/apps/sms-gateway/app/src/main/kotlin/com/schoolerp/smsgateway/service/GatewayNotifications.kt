package com.schoolerp.smsgateway.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.schoolerp.smsgateway.MainActivity
import com.schoolerp.smsgateway.R
import com.schoolerp.smsgateway.engine.GatewayStatus
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The permanent notice is not decoration — it is the price of staying alive in
 * the background, and it doubles as the only place a passing clerk sees that
 * the gateway is healthy. So it says something useful: the school, the state,
 * and today's count.
 */
@Singleton
class GatewayNotifications @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    private val manager: NotificationManager? =
        context.getSystemService(NotificationManager::class.java)

    fun ensureChannels() {
        val status = NotificationChannel(
            CHANNEL_STATUS,
            context.getString(R.string.notification_channel_gateway),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_gateway_desc)
            setShowBadge(false)
        }
        val problem = NotificationChannel(
            CHANNEL_PROBLEM,
            context.getString(R.string.notification_channel_problem),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_problem_desc)
        }
        manager?.createNotificationChannel(status)
        manager?.createNotificationChannel(problem)
    }

    fun ongoing(status: GatewayStatus?): Notification {
        val title = status?.institutionName?.let { "SMS gateway — $it" } ?: "SMS gateway"
        val text = status?.summary ?: "Starting…"
        return NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat_gateway)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail(status)))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openApp())
            .build()
    }

    private fun detail(status: GatewayStatus?): String {
        if (status == null) return "Starting…"
        val stopper = status.blockers.firstOrNull { it.stopsSending }
        if (stopper != null) return "${stopper.headline}. ${stopper.detail}"
        return buildString {
            append("${status.sentToday} sent today")
            if (status.failedToday > 0) append(", ${status.failedToday} failed")
            if (status.queueDepth > 0) append(", ${status.queueDepth} waiting")
            if (status.pendingReceipts > 0) append(", ${status.pendingReceipts} unreported")
        }
    }

    fun update(status: GatewayStatus) {
        manager?.notify(ONGOING_ID, ongoing(status))
    }

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
        const val CHANNEL_STATUS = "gateway_status"
        const val CHANNEL_PROBLEM = "gateway_problem"
        const val ONGOING_ID = 1001
    }
}
