package com.schoolerp.smsgateway.data.remote

import com.schoolerp.smsgateway.core.MessageBody
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// ---------------------------------------------------------------- enrolment

@Serializable
data class ClaimRequest(
    @SerialName("pair_code") val pairCode: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("android_version") val androidVersion: String,
    @SerialName("sim_operator") val simOperator: String?,
)

/* ENROLLING ON THE OFFICE'S OWN LOGIN.

   A pair code needs somebody at a desk generating one within ten minutes of
   somebody else standing over the handset, which is two people and a stopwatch
   for a phone that lives in a drawer. The school already knows who works
   there, so the credential the office already holds is enough, and the server
   records WHO enrolled the phone rather than only that a code was redeemed. */
@Serializable
data class EnrolRequest(
    val phone: String,
    val password: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("android_version") val androidVersion: String,
    @SerialName("sim_operator") val simOperator: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

@Serializable
data class EnrolResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
    val institution: String,
    val name: String,
    @SerialName("poll_seconds") val pollSeconds: Int? = null,
    @SerialName("per_minute_cap") val perMinuteCap: Int? = null,
    /* False when the handset is enrolled and not yet let in. The screen says
       "waiting for the office to approve this phone" rather than showing an
       empty outbox, which is what an unapproved gateway otherwise looks like:
       working, and silent. */
    val approved: Boolean = false,
) {
    override fun toString(): String =
        "EnrolResponse(deviceId=\$deviceId, deviceToken=<redacted>, approved=\$approved)"
}

@Serializable
data class ClaimResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
    val institution: Institution,
    @SerialName("poll_seconds") val pollSeconds: Int? = null,
) {
    /** The token is the phone's only credential; it never reaches a log line. */
    override fun toString(): String =
        "ClaimResponse(deviceId=$deviceId, deviceToken=<redacted>, " +
            "institution=${institution.name}, pollSeconds=$pollSeconds)"
}

/**
 * The contract writes `institution` without fixing its shape, and the two
 * natural readings — a display name, or an object with an id — are both
 * plausible. Rather than guess and have pairing fail on a field mismatch, this
 * accepts either: a bare JSON string, or an object with `name`/`id`.
 */
@Serializable(with = InstitutionSerializer::class)
data class Institution(val id: String?, val name: String)

object InstitutionSerializer : KSerializer<Institution> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Institution")

    override fun deserialize(decoder: Decoder): Institution {
        val input = decoder as? JsonDecoder
            ?: error("Institution can only be read from JSON")
        return when (val element: JsonElement = input.decodeJsonElement()) {
            is JsonPrimitive -> Institution(id = null, name = element.content)
            is JsonObject -> Institution(
                id = element["id"]?.jsonPrimitive?.content,
                name = element["name"]?.jsonPrimitive?.content
                    ?: element["display_name"]?.jsonPrimitive?.content
                    ?: element["id"]?.jsonPrimitive?.content
                    ?: "Unnamed school",
            )
            else -> Institution(id = null, name = "Unnamed school")
        }
    }

    override fun serialize(encoder: Encoder, value: Institution) =
        encoder.encodeString(value.name)
}

// ------------------------------------------------------------------- outbox

@Serializable
data class OutboxResponse(
    val messages: List<OutboxMessage> = emptyList(),
    @SerialName("poll_seconds") val pollSeconds: Int? = null,
    /**
     * Not in the contract. The contract says the server sets a per-minute cap
     * but gives it no field, so this is read if the server ever sends one and
     * otherwise falls back to a conservative local default.
     */
    @SerialName("per_minute_cap") val maxPerMinute: Int? = null,
)

@Serializable
data class OutboxMessage(
    val id: String,
    val to: String,
    val body: MessageBody,
    val attempt: Int = 0,
) {
    /** Neither the body nor the full recipient number belongs in a log line. */
    override fun toString(): String = "OutboxMessage(id=$id, attempt=$attempt)"
}

// ----------------------------------------------------------------- receipts

@Serializable
data class ReceiptsRequest(val receipts: List<Receipt>)

@Serializable
data class Receipt(
    val id: String,
    val status: String,
    @SerialName("sent_at") val sentAt: String,
    val error: String? = null,
    val parts: Int? = null,
) {
    companion object {
        const val STATUS_SENT = "sent"
        const val STATUS_FAILED = "failed"
    }
}

@Serializable
data class ReceiptsResponse(val accepted: Int = 0)

// ---------------------------------------------------------------- heartbeat

@Serializable
data class HeartbeatRequest(
    @SerialName("battery_pct") val batteryPct: Int,
    val charging: Boolean,
    @SerialName("signal_dbm") val signalDbm: Int? = null,
    @SerialName("sim_ready") val simReady: Boolean,
    @SerialName("app_version") val appVersion: String,
    @SerialName("sent_today") val sentToday: Int,
)

@Serializable
data class HeartbeatResponse(
    @SerialName("poll_seconds") val pollSeconds: Int? = null,
    val paused: Boolean = false,
    @SerialName("per_minute_cap") val maxPerMinute: Int? = null,
)
