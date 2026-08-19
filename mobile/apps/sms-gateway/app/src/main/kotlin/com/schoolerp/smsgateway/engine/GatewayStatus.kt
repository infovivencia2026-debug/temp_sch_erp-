package com.schoolerp.smsgateway.engine

import com.schoolerp.smsgateway.data.local.FailureRow

/**
 * Why nothing is going out.
 *
 * The status screen's job is to answer that question in one glance, because the
 * person looking at the phone is a school clerk who has just been told the fee
 * reminders never arrived. Every blocker carries what is wrong, what it costs,
 * and what to do about it.
 */
enum class Blocker {
    NOT_PAIRED,
    NO_SERVER_ADDRESS,
    SMS_PERMISSION_DENIED,
    SIM_NOT_READY,
    NO_NETWORK,
    NOTIFICATIONS_BLOCKED,
    BATTERY_OPTIMISED,
    PHONE_STATE_DENIED,
    PAUSED_BY_SERVER,
    SERVICE_NOT_RUNNING,
    ;

    /** True when this alone stops messages leaving the handset. */
    val stopsSending: Boolean
        get() = when (this) {
            NOT_PAIRED, NO_SERVER_ADDRESS, SMS_PERMISSION_DENIED, SIM_NOT_READY,
            PAUSED_BY_SERVER, SERVICE_NOT_RUNNING,
            -> true
            NO_NETWORK, NOTIFICATIONS_BLOCKED, BATTERY_OPTIMISED, PHONE_STATE_DENIED -> false
        }

    val headline: String
        get() = when (this) {
            NOT_PAIRED -> "This phone is not paired to a school"
            NO_SERVER_ADDRESS -> "No server address"
            SMS_PERMISSION_DENIED -> "This app cannot send SMS"
            SIM_NOT_READY -> "No usable SIM"
            NO_NETWORK -> "No data connection"
            NOTIFICATIONS_BLOCKED -> "Notifications are switched off"
            BATTERY_OPTIMISED -> "Android may put this app to sleep"
            PHONE_STATE_DENIED -> "Signal strength unavailable"
            PAUSED_BY_SERVER -> "The school has paused this gateway"
            SERVICE_NOT_RUNNING -> "The gateway service is not running"
        }

    val detail: String
        get() = when (this) {
            NOT_PAIRED ->
                "Get an 8-character pair code from the admin console and enter it here. " +
                    "Until then this phone will not receive any messages."
            NO_SERVER_ADDRESS ->
                "Enter the school's server address, starting with https://."
            SMS_PERMISSION_DENIED ->
                "Messages are being claimed but cannot be sent. Grant the SMS permission, " +
                    "or the school's messages will keep failing."
            SIM_NOT_READY ->
                "Android reports no SIM ready in this phone. Check the SIM is seated, " +
                    "unlocked, and not disabled in Settings."
            NO_NETWORK ->
                "The phone cannot reach the school's server, so it is not claiming new " +
                    "messages. Anything already claimed will still be sent."
            NOTIFICATIONS_BLOCKED ->
                "The permanent notice is how this app stays alive in the background. " +
                    "With notifications off, Android will stop the gateway."
            BATTERY_OPTIMISED ->
                "Battery optimisation is on for this app. After the phone has been idle " +
                    "for a while, Android will suspend polling and messages will be late."
            PHONE_STATE_DENIED ->
                "The heartbeat cannot report signal strength. Sending is unaffected."
            PAUSED_BY_SERVER ->
                "An administrator has paused this gateway from the admin console. " +
                    "Nothing will be sent until it is resumed there."
            SERVICE_NOT_RUNNING ->
                "The background service has stopped. Open this screen and start it, " +
                    "or restart the phone."
        }
}

enum class ConnectionState { NEVER_CONNECTED, CONNECTED, RETRYING, UNAUTHORISED }

/** Everything the status screen and the notification both read. */
data class GatewayStatus(
    val paired: Boolean = false,
    val institutionName: String? = null,
    val connection: ConnectionState = ConnectionState.NEVER_CONNECTED,
    val lastPollAt: Long = 0L,
    val lastHeartbeatAt: Long = 0L,
    val lastServerError: String? = null,
    val queueDepth: Int = 0,
    val pendingReceipts: Int = 0,
    val sentToday: Int = 0,
    val failedToday: Int = 0,
    val recentFailures: List<FailureRow> = emptyList(),
    val blockers: List<Blocker> = emptyList(),
    val pollSeconds: Int = 30,
    val maxPerMinute: Int = 10,
    val serviceRunning: Boolean = false,
) {
    /** The single sentence the notification shows and the clerk reads first. */
    val summary: String
        get() {
            val stopper = blockers.firstOrNull { it.stopsSending }
            return when {
                stopper != null -> stopper.headline
                queueDepth > 0 -> "Sending — $queueDepth waiting"
                else -> "Ready — $sentToday sent today"
            }
        }

    val healthy: Boolean get() = blockers.none { it.stopsSending }
}

/** A snapshot of the handset, refreshed on a timer and whenever the UI resumes. */
data class DeviceSnapshot(
    val smsPermission: Boolean = false,
    val phoneStatePermission: Boolean = false,
    val simReady: Boolean = false,
    val notificationsAllowed: Boolean = true,
    val ignoringBatteryOptimisations: Boolean = false,
    val hasNetwork: Boolean = false,
    val serviceRunning: Boolean = false,
)
