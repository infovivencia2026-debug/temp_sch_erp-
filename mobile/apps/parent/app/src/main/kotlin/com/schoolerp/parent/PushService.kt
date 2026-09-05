package com.schoolerp.parent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/* THE PHONE IS TOLD, WHETHER OR NOT THE APP IS OPEN.

   The portal's alert feed is polled, and a closed app polls nothing, so a bus
   at the stop or a circular from the school used to wait until the parent
   next opened the app. Firebase wakes this service instead, and it posts the
   phone's own notification.

   Data messages, not notification messages, on purpose: with a notification
   payload Firebase draws the notification itself when the app is in the
   background and hands it to this service only in the foreground, so the two
   cases look different and the tap opens whatever Firebase decides. With data
   the app draws every one the same way and the tap always lands on the link,
   inside the app. */
class PushService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Push.remember(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"]?.takeIf { it.isNotBlank() } ?: getString(R.string.app_name)
        val body = data["body"] ?: ""
        val link = data["link"]?.takeIf { it.startsWith("https://") }
        Push.show(this, title, body, link, data["id"])
    }
}

/** What both the service and the activity know about push. */
object Push {
    const val CHANNEL = "alerts"
    private const val PREF = "push_token"

    fun remember(context: Context, token: String) {
        context.getSharedPreferences("shell", Context.MODE_PRIVATE)
            .edit().putString(PREF, token).apply()
    }

    fun token(context: Context): String? =
        context.getSharedPreferences("shell", Context.MODE_PRIVATE).getString(PREF, null)

    /* One channel, high importance: every alert the school sends is one the
       parent asked to be told about, and a channel they can silence or
       reshape in the phone's own settings, which is where that decision
       belongs. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.channel_alerts_body)
            },
        )
    }

    fun show(context: Context, title: String, body: String, link: String?, id: String?) {
        ensureChannel(context)
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(link ?: BuildConfig.PORTAL_URL)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        // A distinct request code per alert, or every pending intent collapses
        // into the first one's link.
        val code = (id ?: title).hashCode()
        val tap = PendingIntent.getActivity(
            context, code, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
        }
        val notification = builder
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        // Refused silently when the parent has not allowed notifications; the
        // activity asks once, and the phone's settings are the way back.
        runCatching { manager.notify(code, notification) }
    }
}
