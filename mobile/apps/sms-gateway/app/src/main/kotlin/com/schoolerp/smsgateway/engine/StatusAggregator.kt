package com.schoolerp.smsgateway.engine

import com.schoolerp.smsgateway.data.local.FailureRow
import com.schoolerp.smsgateway.data.prefs.GatewaySettings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import javax.inject.Inject
import javax.inject.Singleton

data class QueueCounts(
    val queueDepth: Int = 0,
    val pendingReceipts: Int = 0,
    val sentToday: Int = 0,
    val failedToday: Int = 0,
)

/**
 * The rules that turn raw state into "why is nothing sending".
 *
 * Kept as a pure function so the interesting cases — SIM out, permission
 * refused, server paused — are unit-testable without an emulator.
 */
object StatusRules {

    fun blockers(
        paired: Boolean,
        settings: GatewaySettings,
        device: DeviceSnapshot,
    ): List<Blocker> = buildList {
        if (!paired) add(Blocker.NOT_PAIRED)
        if (settings.baseUrl.isBlank()) add(Blocker.NO_SERVER_ADDRESS)
        if (!device.smsPermission) add(Blocker.SMS_PERMISSION_DENIED)
        if (!device.simReady) add(Blocker.SIM_NOT_READY)
        if (settings.pausedByServer) add(Blocker.PAUSED_BY_SERVER)
        if (paired && !device.serviceRunning) add(Blocker.SERVICE_NOT_RUNNING)
        if (!device.hasNetwork) add(Blocker.NO_NETWORK)
        if (!device.notificationsAllowed) add(Blocker.NOTIFICATIONS_BLOCKED)
        if (!device.ignoringBatteryOptimisations) add(Blocker.BATTERY_OPTIMISED)
        if (!device.phoneStatePermission) add(Blocker.PHONE_STATE_DENIED)
    }

    fun assemble(
        paired: Boolean,
        settings: GatewaySettings,
        connection: ConnectionState,
        device: DeviceSnapshot,
        counts: QueueCounts,
        failures: List<FailureRow>,
    ): GatewayStatus = GatewayStatus(
        paired = paired,
        institutionName = settings.institutionName,
        connection = connection,
        lastPollAt = settings.lastPollAt,
        lastHeartbeatAt = settings.lastHeartbeatAt,
        lastServerError = settings.lastServerError,
        queueDepth = counts.queueDepth,
        pendingReceipts = counts.pendingReceipts,
        sentToday = counts.sentToday,
        failedToday = counts.failedToday,
        recentFailures = failures,
        blockers = blockers(paired, settings, device),
        pollSeconds = settings.pollSeconds,
        maxPerMinute = settings.maxPerMinute,
        serviceRunning = device.serviceRunning,
    )
}

@Singleton
class StatusAggregator @Inject constructor(
    private val sources: StatusSources,
    private val signals: EngineSignals,
) {

    private val counts: Flow<QueueCounts> = combine(
        sources.observeQueueDepth(),
        sources.observePendingReceipts(),
        sources.observeSentToday(),
        sources.observeFailedToday(),
    ) { depth, pending, sent, failed -> QueueCounts(depth, pending, sent, failed) }

    val status: Flow<GatewayStatus> = combine(
        sources.settings,
        sources.paired,
        signals.signals,
        counts,
        sources.observeRecentFailures(),
    ) { settings, paired, (connection, device), counts, failures ->
        StatusRules.assemble(paired, settings, connection, device, counts, failures)
    }.distinctUntilChanged()
}
