package com.schoolerp.smsgateway.engine

import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.core.TimeSource
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.data.repo.PollOutcome
import com.schoolerp.smsgateway.data.remote.ApiFailure
import com.schoolerp.smsgateway.sms.DeviceStatusProvider
import com.schoolerp.smsgateway.sms.SmsFailure
import com.schoolerp.smsgateway.sms.SmsSendException
import com.schoolerp.smsgateway.sms.SmsSender
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.coroutineContext

/**
 * The whole working life of the gateway: claim, send, report, heartbeat.
 *
 * It runs inside the foreground service's scope and is deliberately five small
 * independent loops rather than one big one. A server outage must not stop the
 * radio finishing messages already claimed; a SIM that has been pulled must not
 * stop receipts for messages already sent reaching the server. Coupling those
 * would produce exactly the failure the contract warns about — a school that
 * believes messages are going out.
 */
@Singleton
class GatewayEngine @Inject constructor(
    private val repository: GatewayRepository,
    private val smsSender: SmsSender,
    private val deviceStatus: DeviceStatusProvider,
    private val signals: EngineSignals,
    private val timeSource: TimeSource,
) {

    private val rateLimiter = RateLimiter(timeSource)

    /** When the current send-blocking condition began. Null when unblocked. */
    private var blockedSince: Long? = null

    suspend fun run(): Unit = coroutineScope {
        // The window is seeded from durable history so restarting the service
        // cannot buy a fresh minute's carrier allowance.
        rateLimiter.seed(repository.recentSendTimestamps(RATE_WINDOW_MILLIS))
        signals.publishServiceRunning(true)

        launch { deviceLoop() }
        launch { pollLoop() }
        launch { dispatchLoop() }
        launch { receiptLoop() }
        launch { heartbeatLoop() }
        launch { upkeepLoop() }
    }

    // ------------------------------------------------------------------ loops

    private suspend fun deviceLoop() {
        while (coroutineContext.isActive) {
            refreshDeviceSnapshot()
            delay(DEVICE_REFRESH_MILLIS)
        }
    }

    fun refreshDeviceSnapshot() {
        signals.publishDevice(
            DeviceSnapshot(
                smsPermission = smsSender.hasPermission(),
                phoneStatePermission = deviceStatus.hasPhoneStatePermission(),
                simReady = deviceStatus.simReady(),
                notificationsAllowed = deviceStatus.notificationsAllowed(),
                ignoringBatteryOptimisations = deviceStatus.ignoringBatteryOptimisations(),
                hasNetwork = deviceStatus.hasNetwork(),
                serviceRunning = signals.device.value.serviceRunning,
            ),
        )
    }

    private suspend fun pollLoop() {
        val backoff = Backoff()
        while (coroutineContext.isActive) {
            val settings = repository.settings.first()
            if (settings.pausedByServer) {
                // Claiming while paused would strand messages in `dispatching`
                // on the server for the length of their lease.
                delay(PAUSED_IDLE_MILLIS)
                continue
            }

            when (val outcome = repository.poll()) {
                is PollOutcome.Claimed -> {
                    signals.publishConnection(ConnectionState.CONNECTED)
                    backoff.reset()
                    if (outcome.count > 0) GwLog.i("poll", "claimed ${outcome.count} message(s)")
                    // A full batch means there is more waiting; go straight back.
                    val wait = if (outcome.count >= 20) 0L else outcome.pollSeconds * 1000L
                    delay(wait)
                }
                is PollOutcome.Failed -> {
                    signals.publishConnection(
                        if (outcome.failure is ApiFailure.Unauthorized) ConnectionState.UNAUTHORISED
                        else ConnectionState.RETRYING,
                    )
                    val wait = (outcome.failure as? ApiFailure.RateLimited)
                        ?.retryAfterSeconds?.times(1000L)
                        ?: backoff.nextDelayMillis()
                    delay(wait)
                }
                PollOutcome.Unpaired, PollOutcome.NotConfigured -> {
                    signals.publishConnection(ConnectionState.NEVER_CONNECTED)
                    delay(UNPAIRED_IDLE_MILLIS)
                }
            }
        }
    }

    private suspend fun dispatchLoop() {
        while (coroutineContext.isActive) {
            val settings = repository.settings.first()
            if (settings.pausedByServer) {
                delay(PAUSED_IDLE_MILLIS)
                continue
            }

            val blockedReason = sendBlockedReason()
            if (blockedReason != null) {
                handleBlocked(blockedReason)
                delay(BLOCKED_RECHECK_MILLIS)
                continue
            }
            blockedSince = null

            val rows = repository.nextQueued(DISPATCH_BATCH)
            if (rows.isEmpty()) {
                delay(IDLE_TICK_MILLIS)
                continue
            }

            rows.forEach { row ->
                if (!coroutineContext.isActive) return@forEach
                rateLimiter.acquire(settings.maxPerMinute)
                dispatch(row.id, row.toAddress, repository.bodyOf(row))
            }
        }
    }

    private suspend fun dispatch(id: String, to: String, body: com.schoolerp.smsgateway.core.MessageBody) {
        val parts = try {
            smsSender.partCount(body)
        } catch (error: Exception) {
            GwLog.w("send", "could not measure message $id", error)
            1
        }

        // Claim the row locally before touching the radio. If this returns
        // false another pass already took it, and sending again would be a
        // duplicate SMS to a parent.
        if (!repository.markSending(id, parts)) {
            GwLog.d("send", "message $id already claimed by another pass")
            return
        }

        try {
            smsSender.send(id, to, body)
        } catch (refusal: SmsSendException) {
            repository.settleLocalFailure(id, refusal.reason)
        } catch (error: Exception) {
            GwLog.e("send", "unexpected failure handing $id to the radio", error)
            repository.settleLocalFailure(id, "unexpected:${error.javaClass.simpleName}")
        }
    }

    private suspend fun receiptLoop() {
        while (coroutineContext.isActive) {
            repository.flushReceipts()
            delay(RECEIPT_TICK_MILLIS)
        }
    }

    private suspend fun heartbeatLoop() {
        // A little offset so a hall full of gateways does not heartbeat in
        // lockstep after a power cut.
        delay((timeSource.nowMillis() % 5_000L))
        while (coroutineContext.isActive) {
            val settings = repository.settings.first()
            repository.sendHeartbeat()
            val interval = (settings.pollSeconds * 5L).coerceIn(60L, 300L) * 1000L
            delay(interval)
        }
    }

    private suspend fun upkeepLoop() {
        while (coroutineContext.isActive) {
            delay(UPKEEP_TICK_MILLIS)
            repository.sweepStuckSends(SEND_RESULT_TIMEOUT_MILLIS)
            repository.prune(RETENTION_MILLIS)
        }
    }

    // --------------------------------------------------------------- blocking

    private fun sendBlockedReason(): String? = when {
        !smsSender.hasPermission() -> SmsFailure.PERMISSION_DENIED
        !deviceStatus.simReady() -> SmsFailure.SIM_NOT_READY
        else -> null
    }

    /**
     * A block that a human has to clear — no permission, no SIM.
     *
     * Silently holding claimed messages would be the worst outcome: the server
     * has already moved them to `dispatching`, and when the lease expires it
     * re-queues them and hands them straight back to the same broken phone, for
     * ever. So after a grace period the rows are reported `failed` with the
     * real reason. The grace exists because a SIM is not readable for a few
     * seconds after boot, and the queue must not be destroyed by that.
     */
    private suspend fun handleBlocked(reason: String) {
        val since = blockedSince ?: timeSource.nowMillis().also { blockedSince = it }
        if (timeSource.nowMillis() - since < BLOCKED_GRACE_MILLIS) return

        val stranded = repository.nextQueued(DISPATCH_BATCH)
        if (stranded.isEmpty()) return
        GwLog.w("send", "blocked by $reason; reporting ${stranded.size} message(s) failed")
        stranded.forEach { repository.settleLocalFailure(it.id, reason) }
    }

    private companion object {
        const val DISPATCH_BATCH = 20
        const val IDLE_TICK_MILLIS = 3_000L
        const val PAUSED_IDLE_MILLIS = 30_000L
        const val UNPAIRED_IDLE_MILLIS = 15_000L
        const val BLOCKED_RECHECK_MILLIS = 5_000L
        const val RECEIPT_TICK_MILLIS = 10_000L
        const val DEVICE_REFRESH_MILLIS = 15_000L
        const val UPKEEP_TICK_MILLIS = 10 * 60_000L
        const val RATE_WINDOW_MILLIS = 60_000L

        /** How long the radio gets to report a result before we call it lost. */
        const val SEND_RESULT_TIMEOUT_MILLIS = 10 * 60_000L

        /** A SIM takes a few seconds to come up after boot. Do not panic. */
        const val BLOCKED_GRACE_MILLIS = 10 * 60_000L

        /** A week of "what went wrong on Tuesday", then it goes. */
        const val RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000L
    }
}
