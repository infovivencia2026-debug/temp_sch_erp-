package com.schoolerp.smsgateway.sms

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.core.MessageBody
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** Thrown when the handset refuses the send outright, before the radio sees it. */
class SmsSendException(val reason: String, cause: Throwable? = null) : Exception(reason, cause)

/**
 * The one place that hands text to the radio.
 *
 * Two properties matter here. First, a body longer than one GSM segment goes
 * through [SmsManager.sendMultipartTextMessage] — sending it as a single
 * message would silently truncate a fee reminder halfway through an amount.
 * Second, every part carries its own sent and delivered [PendingIntent], so
 * what gets reported to the server is what the radio actually did, not what
 * this app hoped it would do.
 */
@Singleton
class SmsSender @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
            PackageManager.PERMISSION_GRANTED

    /** How many segments this body will cost. Used for the `parts` field. */
    fun partCount(body: MessageBody): Int =
        smsManager().divideMessage(body.expose()).size.coerceAtLeast(1)

    /**
     * Hands one message to the radio and returns the number of segments it was
     * split into. Returning does **not** mean it was sent: results arrive later
     * as broadcasts to [SmsResultReceiver].
     */
    fun send(messageId: String, to: String, body: MessageBody): Int {
        if (!hasPermission()) throw SmsSendException(SmsFailure.PERMISSION_DENIED)
        if (body.isBlank) throw SmsSendException(SmsFailure.EMPTY_BODY)

        val manager = smsManager()
        val parts = manager.divideMessage(body.expose())
        val count = parts.size.coerceAtLeast(1)

        val sentIntents = ArrayList<PendingIntent>(count)
        val deliveredIntents = ArrayList<PendingIntent>(count)
        for (index in 0 until count) {
            sentIntents += resultIntent(SmsResultReceiver.ACTION_SENT, messageId, index, count)
            deliveredIntents += resultIntent(SmsResultReceiver.ACTION_DELIVERED, messageId, index, count)
        }

        try {
            if (count == 1) {
                manager.sendTextMessage(
                    to,
                    null,
                    parts.firstOrNull() ?: body.expose(),
                    sentIntents.first(),
                    deliveredIntents.first(),
                )
            } else {
                manager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveredIntents)
            }
        } catch (security: SecurityException) {
            throw SmsSendException(SmsFailure.PERMISSION_DENIED, security)
        } catch (illegal: IllegalArgumentException) {
            // A malformed destination from the server, not a radio problem.
            throw SmsSendException("invalid_destination", illegal)
        }

        GwLog.i("send", "handed message $messageId to the radio in $count part(s)")
        return count
    }

    /**
     * The result intents must be distinguishable. Android collapses
     * [PendingIntent]s that differ only in their extras, so the message id and
     * part index go into the intent's *data* URI where they are part of the
     * identity, not just into extras where they are not.
     */
    private fun resultIntent(action: String, messageId: String, index: Int, count: Int): PendingIntent {
        val intent = Intent(action).apply {
            setClass(context, SmsResultReceiver::class.java)
            data = "smsgateway://result/$action/$messageId/$index".toUri()
            putExtra(SmsResultReceiver.EXTRA_MESSAGE_ID, messageId)
            putExtra(SmsResultReceiver.EXTRA_PART_INDEX, index)
            putExtra(SmsResultReceiver.EXTRA_PART_COUNT, count)
        }
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun smsManager(): SmsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
}
