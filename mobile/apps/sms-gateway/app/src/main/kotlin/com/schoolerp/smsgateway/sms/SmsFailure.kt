package com.schoolerp.smsgateway.sms

import android.app.Activity

/**
 * Turns a platform `resultCode` into the short reason that goes on the wire in
 * a receipt's `error`, and into the sentence the office reads on the status
 * screen.
 *
 * The codes are written as literals rather than [android.telephony.SmsManager]
 * constants because several of them only became public API at 30 while the
 * radio has been returning them since long before, and this app runs from 26.
 */
object SmsFailure {

    const val OK = "ok"

    fun reasonFor(resultCode: Int): String? = when (resultCode) {
        Activity.RESULT_OK -> null
        1 -> "generic_failure"
        2 -> "radio_off"
        3 -> "null_pdu"
        4 -> "no_service"
        5 -> "limit_exceeded"
        6 -> "fdn_check_failure"
        7 -> "short_code_not_allowed"
        8 -> "short_code_never_allowed"
        9 -> "radio_not_available"
        10 -> "network_reject"
        11 -> "invalid_arguments"
        12 -> "invalid_state"
        13 -> "no_memory"
        14 -> "invalid_sms_format"
        15 -> "system_error"
        16 -> "modem_error"
        17 -> "network_error"
        18 -> "encoding_error"
        19 -> "invalid_smsc_address"
        20 -> "operation_not_allowed"
        21 -> "internal_error"
        22 -> "no_resources"
        23 -> "cancelled"
        24 -> "request_not_supported"
        25 -> "no_bluetooth_service"
        26 -> "invalid_bluetooth_address"
        27 -> "bluetooth_disconnected"
        28 -> "unexpected_event_stop_sending"
        29 -> "sms_blocked_during_emergency"
        30 -> "sms_send_retry_failed"
        31 -> "remote_exception"
        32 -> "no_default_sms_app"
        else -> "result_$resultCode"
    }

    /** Reasons raised by this app rather than by the radio. */
    const val PERMISSION_DENIED = "sms_permission_denied"
    const val SIM_NOT_READY = "sim_not_ready"
    const val NO_RESULT = "no_send_result"
    const val EMPTY_BODY = "empty_body"

    /**
     * Plain English for the office. "generic_failure" tells a school nothing;
     * "the SIM has no credit or the number was rejected" tells them who to
     * ring.
     */
    fun explain(reason: String?): String = when (reason) {
        null, OK -> "Sent."
        "generic_failure" -> "The network refused the message. Usually no balance on the SIM, or the number is not reachable."
        "radio_off" -> "The phone's radio is off — flight mode, or the SIM is disabled."
        "no_service" -> "No mobile network where this phone is sitting."
        "radio_not_available" -> "The radio is not responding. Restart the phone."
        "limit_exceeded" -> "The carrier is throttling this SIM. Too many messages too quickly."
        "null_pdu" -> "The message could not be encoded. Report this — it is a bug."
        "fdn_check_failure" -> "Fixed Dialling Numbers is switched on for this SIM and the recipient is not on the list."
        "short_code_not_allowed", "short_code_never_allowed" -> "The recipient looks like a short code, which this SIM may not message."
        "no_default_sms_app" -> "Android has no default SMS app set. Set one in Settings."
        "invalid_smsc_address" -> "The SIM's message centre number is wrong. Check it in the phone's settings."
        "sms_blocked_during_emergency" -> "The network is in an emergency mode and is blocking SMS."
        PERMISSION_DENIED -> "This app does not have permission to send SMS."
        SIM_NOT_READY -> "No usable SIM in this phone."
        NO_RESULT -> "The phone never reported what happened to this message. It may or may not have gone out."
        EMPTY_BODY -> "The server sent an empty message body."
        else -> "The phone reported: $reason"
    }
}
