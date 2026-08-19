package com.schoolerp.smsgateway.data.repo

import androidx.room.withTransaction
import com.schoolerp.smsgateway.core.BaseUrl
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.core.MessageBody
import com.schoolerp.smsgateway.core.PairCode
import com.schoolerp.smsgateway.core.TimeSource
import com.schoolerp.smsgateway.core.startOfLocalDay
import com.schoolerp.smsgateway.core.toRfc3339
import com.schoolerp.smsgateway.data.local.FailureRow
import com.schoolerp.smsgateway.data.local.GatewayDatabase
import com.schoolerp.smsgateway.data.local.MessageDao
import com.schoolerp.smsgateway.data.local.MessageEntity
import com.schoolerp.smsgateway.data.local.MessageState
import com.schoolerp.smsgateway.data.prefs.GatewaySettings
import com.schoolerp.smsgateway.data.prefs.SettingsStore
import com.schoolerp.smsgateway.data.prefs.TokenStore
import com.schoolerp.smsgateway.data.remote.ApiFailure
import com.schoolerp.smsgateway.data.remote.ClaimRequest
import com.schoolerp.smsgateway.data.remote.GatewayApi
import com.schoolerp.smsgateway.data.remote.HeartbeatRequest
import com.schoolerp.smsgateway.data.remote.Receipt
import com.schoolerp.smsgateway.data.remote.ReceiptsRequest
import com.schoolerp.smsgateway.di.AllowInsecureHttpBuild
import com.schoolerp.smsgateway.engine.Backoff
import com.schoolerp.smsgateway.engine.StatusSources
import com.schoolerp.smsgateway.sms.DeviceStatusProvider
import com.schoolerp.smsgateway.sms.SmsFailure
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

/** What a poll attempt did, in terms the service loop and the UI both use. */
sealed interface PollOutcome {
    data class Claimed(val count: Int, val pollSeconds: Int) : PollOutcome
    data object NotConfigured : PollOutcome
    data object Unpaired : PollOutcome
    data class Failed(val failure: ApiFailure) : PollOutcome
}

sealed interface PairOutcome {
    data class Paired(val institutionName: String) : PairOutcome
    data class Rejected(val message: String) : PairOutcome
}

@Singleton
class GatewayRepository @Inject constructor(
    private val api: GatewayApi,
    private val db: GatewayDatabase,
    private val dao: MessageDao,
    private val tokenStore: TokenStore,
    private val settingsStore: SettingsStore,
    private val deviceStatus: DeviceStatusProvider,
    private val timeSource: TimeSource,
    @param:AllowInsecureHttpBuild private val allowInsecureHttpBuild: Boolean,
) : StatusSources {

    override val settings: Flow<GatewaySettings> = settingsStore.settings
    override val paired = tokenStore.paired

    // ------------------------------------------------------------- enrolment

    /**
     * The one unauthenticated call. On success the token is sealed away
     * immediately and the school's name is handed back, so the operator can see
     * they paired to the right place before walking away from the phone.
     */
    suspend fun pair(rawBaseUrl: String, rawPairCode: String): PairOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(rawBaseUrl, allowInsecureHttp(settings)).getOrElse {
            return PairOutcome.Rejected(it.message ?: "That server address is not usable.")
        }
        val code = PairCode.normalise(rawPairCode)
        if (code.length != PairCode.LENGTH) {
            return PairOutcome.Rejected("A pair code is ${PairCode.LENGTH} characters.")
        }

        return try {
            val response = api.claim(
                baseUrl,
                ClaimRequest(
                    pairCode = code,
                    deviceName = deviceStatus.deviceName(),
                    androidVersion = deviceStatus.androidVersion(),
                    simOperator = deviceStatus.simOperator(),
                ),
            )
            tokenStore.save(response.deviceId, response.deviceToken)
            settingsStore.setBaseUrl(baseUrl.value)
            settingsStore.recordPairing(
                deviceId = response.deviceId,
                institutionId = response.institution.id,
                institutionName = response.institution.name,
            )
            settingsStore.applyServerDirectives(response.pollSeconds, paused = false, maxPerMinute = null)
            GwLog.i("pair", "paired device ${response.deviceId}")
            PairOutcome.Paired(response.institution.name)
        } catch (failure: ApiFailure) {
            GwLog.w("pair", "claim refused: ${failure.reason}")
            PairOutcome.Rejected(pairErrorMessage(failure))
        }
    }

    private fun pairErrorMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Network -> "Could not reach the school's server. Check the address and this phone's data connection."
        is ApiFailure.Unauthorized -> "That pair code was refused."
        is ApiFailure.RateLimited -> "Too many attempts. Wait a minute and try again."
        is ApiFailure.Server -> "The school's server had a problem (${failure.status}). Try again shortly."
        is ApiFailure.Rejected ->
            if (failure.status == 404 || failure.status == 400 || failure.status == 410) {
                "That pair code is wrong or has expired. Codes last ten minutes — generate a new one."
            } else {
                "The server refused the pairing (${failure.status})."
            }
        is ApiFailure.Malformed -> "The server's reply could not be understood. The app and the server may be different versions."
    }

    suspend fun unpair() {
        tokenStore.clear()
        settingsStore.clearPairing()
    }

    // ---------------------------------------------------------------- outbox

    /**
     * Claim, then persist, then — much later — send.
     *
     * The order is the whole point. The rows are committed to SQLite before
     * anything is handed to the radio, so a crash, a battery pull or an OOM
     * kill between the claim and the send leaves the messages recoverable on
     * this phone rather than stranded in the server's `dispatching` state.
     */
    suspend fun poll(): PollOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(settings.baseUrl, allowInsecureHttp(settings)).getOrNull()
            ?: return PollOutcome.NotConfigured
        val token = tokenStore.token() ?: return PollOutcome.Unpaired

        return try {
            val response = api.outbox(baseUrl, token, GatewayApi.MAX_OUTBOX_BATCH)
            val now = timeSource.nowMillis()
            val rows = response.messages.map { message ->
                MessageEntity(
                    id = message.id,
                    toAddress = message.to,
                    // One of exactly two places the raw text is unwrapped.
                    bodyRaw = message.body.expose(),
                    attempt = message.attempt,
                    claimedAt = now,
                )
            }
            val inserted = if (rows.isEmpty()) emptyList() else dao.insertIgnoringKnown(rows)
            val newRows = inserted.count { it != -1L }
            if (newRows != rows.size) {
                GwLog.i("poll", "server re-delivered ${rows.size - newRows} id(s) already held; ignored")
            }
            settingsStore.applyServerDirectives(response.pollSeconds, null, response.maxPerMinute)
            settingsStore.recordPoll(now, null)
            PollOutcome.Claimed(newRows, response.pollSeconds ?: settings.pollSeconds)
        } catch (failure: ApiFailure) {
            settingsStore.recordPoll(timeSource.nowMillis(), failure.reason)
            if (failure is ApiFailure.Unauthorized) {
                GwLog.w("poll", "server rejected our token; unpairing")
                unpair()
            }
            PollOutcome.Failed(failure)
        }
    }

    suspend fun nextQueued(limit: Int): List<MessageEntity> = dao.nextQueued(limit)

    fun bodyOf(row: MessageEntity): MessageBody = MessageBody(row.bodyRaw)

    suspend fun markSending(id: String, parts: Int): Boolean =
        dao.markSending(id, parts, timeSource.nowMillis()) == 1

    /** A send this app refused before the radio saw it — permission, empty body. */
    suspend fun settleLocalFailure(id: String, reason: String) {
        dao.settle(id, MessageState.FAILED, timeSource.nowMillis(), reason)
        GwLog.w("send", "message $id failed locally: $reason")
    }

    /**
     * One segment reported back. The row settles only when every segment has,
     * and a single failed segment fails the whole message: a fee reminder
     * missing its second half is not a delivered fee reminder.
     */
    suspend fun recordPartResult(id: String, resultCode: Int) {
        val reason = SmsFailure.reasonFor(resultCode)
        db.withTransaction {
            dao.recordPartResult(id, reason)
            val remaining = dao.partsPending(id)
            val row = if (remaining != null && remaining <= 0) dao.byId(id) else null
            if (row != null) {
                val state = if (row.error == null) MessageState.SENT else MessageState.FAILED
                dao.settle(id, state, timeSource.nowMillis(), row.error)
            }
        }
        GwLog.i("send", "message $id part result ${reason ?: SmsFailure.OK}")
    }

    suspend fun recordDelivery(id: String, resultCode: Int) {
        val delivered = SmsFailure.reasonFor(resultCode) == null
        dao.recordDelivery(id, delivered)
        GwLog.i("send", "message $id delivery report: $delivered")
    }

    /**
     * Android does not promise a sent broadcast if the process dies between the
     * call and the callback. Without this a row sits in SENDING for ever and
     * the server never hears an answer, so after a generous wait it is reported
     * `failed` with `no_send_result`. That is the honest report: the app does
     * not know. It may cause the server to re-queue a message that did in fact
     * go out, which is a duplicate SMS — the lesser of the two evils against a
     * fee reminder that silently never arrives.
     */
    suspend fun sweepStuckSends(timeoutMillis: Long): Int {
        val cutoff = timeSource.nowMillis() - timeoutMillis
        val stuck = dao.stuckSending(cutoff)
        stuck.forEach { row ->
            dao.settle(row.id, MessageState.FAILED, timeSource.nowMillis(), SmsFailure.NO_RESULT)
            GwLog.w("send", "message ${row.id} produced no result in time; reported failed")
        }
        return stuck.size
    }

    // -------------------------------------------------------------- receipts

    /**
     * Retried until the server says it took them. A receipt that never lands
     * means the server's lease expires and it sends the message again, so this
     * loop never gives up and never drops a row on the floor — it only backs
     * off.
     */
    suspend fun flushReceipts(): Boolean {
        val now = timeSource.nowMillis()
        val due = dao.receiptsDue(now, RECEIPT_BATCH)
        if (due.isEmpty()) return true

        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(settings.baseUrl, allowInsecureHttp(settings)).getOrNull() ?: return false
        val token = tokenStore.token() ?: return false

        val receipts = due.map { row ->
            Receipt(
                id = row.id,
                status = if (row.state == MessageState.SENT) Receipt.STATUS_SENT else Receipt.STATUS_FAILED,
                sentAt = (row.sentAt ?: now).toRfc3339(),
                error = row.error.takeIf { row.state == MessageState.FAILED },
                parts = row.parts.takeIf { it > 0 },
            )
        }

        return try {
            val response = api.receipts(baseUrl, token, ReceiptsRequest(receipts))
            if (response.accepted >= receipts.size) {
                dao.markReceiptsAccepted(due.map { it.id })
                GwLog.i("receipts", "server accepted ${response.accepted} receipt(s)")
                true
            } else {
                // The contract's `accepted: n` is a count, not a list, so a
                // partial acceptance does not say which ones landed. Receipts
                // are idempotent on id, so re-sending the whole batch is safe
                // and is the only thing that is.
                GwLog.w("receipts", "server accepted ${response.accepted} of ${receipts.size}; retrying batch")
                deferAll(due, now)
                false
            }
        } catch (failure: ApiFailure) {
            if (failure is ApiFailure.Unauthorized) {
                GwLog.w("receipts", "token rejected while reporting; unpairing")
                unpair()
                return false
            }
            GwLog.w("receipts", "could not report ${receipts.size} receipt(s): ${failure.reason}")
            deferAll(due, now)
            false
        }
    }

    private suspend fun deferAll(rows: List<MessageEntity>, now: Long) {
        // Backoff is per row, driven by that row's own attempt count, so one
        // stubborn receipt does not slow the rest down.
        rows.groupBy { it.receiptAttempts }.forEach { (attempts, group) ->
            dao.deferReceipts(group.map { it.id }, now + Backoff.forReceiptAttempt(attempts))
        }
    }

    // ------------------------------------------------------------- heartbeat

    suspend fun sendHeartbeat(): Boolean {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(settings.baseUrl, allowInsecureHttp(settings)).getOrNull() ?: return false
        val token = tokenStore.token() ?: return false

        val now = timeSource.nowMillis()
        val request = HeartbeatRequest(
            batteryPct = deviceStatus.batteryPct(),
            charging = deviceStatus.charging(),
            signalDbm = deviceStatus.signalDbm(),
            simReady = deviceStatus.simReady(),
            appVersion = deviceStatus.appVersion(),
            sentToday = dao.countSentSince(startOfLocalDay(now)),
        )

        return try {
            val response = api.heartbeat(baseUrl, token, request)
            settingsStore.applyServerDirectives(response.pollSeconds, response.paused, response.maxPerMinute)
            settingsStore.recordHeartbeat(now)
            true
        } catch (failure: ApiFailure) {
            if (failure is ApiFailure.Unauthorized) unpair()
            GwLog.w("heartbeat", "not delivered: ${failure.reason}")
            false
        }
    }

    // -------------------------------------------------------------- upkeep

    suspend fun recentSendTimestamps(windowMillis: Long): List<Long> =
        dao.sendTimestampsSince(timeSource.nowMillis() - windowMillis)

    suspend fun prune(retentionMillis: Long): Int =
        dao.pruneSettledBefore(timeSource.nowMillis() - retentionMillis)

    // ------------------------------------------------------------ observers

    override fun observeQueueDepth(): Flow<Int> = dao.observeQueueDepth()
    override fun observePendingReceipts(): Flow<Int> = dao.observePendingReceipts()
    override fun observeSentToday(): Flow<Int> = dao.observeSentSince(startOfLocalDay(timeSource.nowMillis()))
    override fun observeFailedToday(): Flow<Int> = dao.observeFailedSince(startOfLocalDay(timeSource.nowMillis()))
    override fun observeRecentFailures(limit: Int): Flow<List<FailureRow>> =
        dao.observeRecentFailures(startOfLocalDay(timeSource.nowMillis()) - TWO_DAYS, limit)

    private fun allowInsecureHttp(settings: GatewaySettings): Boolean =
        allowInsecureHttpBuild && settings.allowInsecureHttp

    private companion object {
        const val RECEIPT_BATCH = 50
        const val TWO_DAYS = 2 * 24 * 60 * 60 * 1000L
    }
}
