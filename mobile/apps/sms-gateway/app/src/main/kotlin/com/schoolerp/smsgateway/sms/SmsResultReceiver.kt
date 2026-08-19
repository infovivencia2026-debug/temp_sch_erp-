package com.schoolerp.smsgateway.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.di.ApplicationScope
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Where the truth about a send comes from.
 *
 * `SmsManager.send*` returning is not evidence that anything left the handset;
 * only these broadcasts are. They are the reason the receipt the school's
 * server gets says what happened rather than what was attempted.
 *
 * Declared in the manifest rather than registered at runtime, so a result that
 * arrives after the process has been killed still lands: Android restarts the
 * app to deliver it.
 */
@AndroidEntryPoint
class SmsResultReceiver : BroadcastReceiver() {

    @Inject lateinit var repository: GatewayRepository

    @Inject @ApplicationScope lateinit var scope: CoroutineScope

    override fun onReceive(context: Context, intent: Intent) {
        val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID)
        if (messageId.isNullOrEmpty()) {
            GwLog.w("send", "result broadcast with no message id; ignored")
            return
        }
        val code = resultCode
        val action = intent.action

        // The database write outlives onReceive, so the process must be kept
        // alive across it or a send result is lost on a busy handset.
        val pending = goAsync()
        scope.launch {
            try {
                when (action) {
                    ACTION_SENT -> repository.recordPartResult(messageId, code)
                    ACTION_DELIVERED -> repository.recordDelivery(messageId, code)
                    else -> GwLog.w("send", "unknown result action for $messageId")
                }
            } catch (error: Exception) {
                GwLog.e("send", "failed to record result for $messageId", error)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_SENT = "com.schoolerp.smsgateway.SMS_SENT"
        const val ACTION_DELIVERED = "com.schoolerp.smsgateway.SMS_DELIVERED"
        const val EXTRA_MESSAGE_ID = "message_id"
        const val EXTRA_PART_INDEX = "part_index"
        const val EXTRA_PART_COUNT = "part_count"
    }
}
