package com.schoolerp.bustracker.data.remote

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/*
 * Every name here is copied from docs/BUS_TRACKER_CONTRACT.md, not paraphrased
 * from it. The SMS gateway shipped a silent misbehaviour because its contract
 * left a field unnamed and the two halves guessed differently — per_minute_cap
 * against max_per_minute — and neither side failed, logged, or noticed. The
 * WireContractTest in this module asserts the serialised JSON key of every
 * field below, so that drift becomes a red test rather than a bus that is
 * quietly not on the map.
 */

// ---------------------------------------------------------------- enrolment

@Serializable
data class ClaimRequest(
    @SerialName("pair_code") val pairCode: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("device_model") val deviceModel: String,
    @SerialName("android_version") val androidVersion: String,
    @SerialName("app_version") val appVersion: String,
)

@Serializable
data class ClaimResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
    /**
     * The contract writes `institution` without fixing its shape. The server
     * currently sends a bare uuid string; an object with `id`/`name` is the
     * other natural reading. [InstitutionSerializer] accepts either rather than
     * failing the pairing on a field mismatch, and this app only ever displays
     * it, so a uuid showing here is ugly and not dangerous.
     */
    val institution: Institution? = null,
    val vehicle: Vehicle,
    @SerialName("ping_seconds") val pingSeconds: Int? = null,
) {
    /** The token is the phone's only credential; it never reaches a log line. */
    override fun toString(): String =
        "ClaimResponse(deviceId=$deviceId, deviceToken=<redacted>, " +
            "vehicle=${vehicle.registrationNo}, pingSeconds=$pingSeconds)"
}

/**
 * The registration is the whole safety mechanism of pairing: the vehicle is
 * chosen in the office when the code is generated, and echoed here so the
 * driver can see which bus their phone has become before it reports anything.
 * A driver shown the wrong registration stops there.
 */
@Serializable
data class Vehicle(
    val id: String? = null,
    @SerialName("registration_no") val registrationNo: String,
)

@Serializable(with = InstitutionSerializer::class)
data class Institution(val id: String?, val name: String)

object InstitutionSerializer : KSerializer<Institution> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Institution")

    override fun deserialize(decoder: Decoder): Institution {
        val input = decoder as? JsonDecoder ?: error("Institution can only be read from JSON")
        return when (val element: JsonElement = input.decodeJsonElement()) {
            is JsonPrimitive -> Institution(id = element.content, name = element.content)
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

    override fun serialize(encoder: Encoder, value: Institution) = encoder.encodeString(value.name)
}

// -------------------------------------------------------------------- trips

/* THE DRIVER'S SHIFT.
 *
 * The server gates trip start and end on `X-Staff-Session`, a token minted by
 * POST /api/v1/bus-tracker/session in exchange for the phone number and PIN
 * the office already issued the driver. This app never asked for one, so both
 * routes answered 401 `not_signed_in` and no trip could ever be opened: the
 * handset paired, heartbeated and reported position, and the Start button
 * failed every time.
 *
 * The device token identifies the BUS. This identifies the person driving it,
 * which is what a parent is asking when they ask who was on the route.
 */
/* THE ONLY WAY IN THAT NEEDS NOBODY IN THE OFFICE.
 *
 * A pair code took two people and a stopwatch: somebody generated it, the
 * driver typed it within ten minutes, and the driver is beside the bus at six
 * in the morning while the office opens at nine.
 *
 * HR already records who drives which bus. So the phone number and the PIN the
 * office issued are enough on their own, and the server answers with the bus
 * it finds against that person -- which is also narrower than a pair code was,
 * because a driver cannot attach a handset to a route that is not theirs.
 */
/* Enrolling against the bus the driver is actually standing next to.

   The sticker in the windscreen carries the bus code; the same field also
   accepts a registration typed by hand, because the server matches either. */
@Serializable
data class EnrolRequest(
    val phone: String,
    val pin: String,
    @SerialName("registration_no") val bus: String,
    @SerialName("device_model") val deviceModel: String? = null,
    @SerialName("android_version") val androidVersion: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

@Serializable
data class DriverSignInRequest(
    val phone: String,
    /* The driver's ordinary login password -- the one the office issues from
       the staff record, not a separate numeric code. The server still accepts
       a PIN in this field for handsets issued one. */
    val password: String,
    @SerialName("device_model") val deviceModel: String? = null,
    @SerialName("android_version") val androidVersion: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

@Serializable
data class DriverSignInResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
    /* THE SHIFT, not just the handset.
     *
     * Starting a run is gated on the staff session, not on the device token,
     * because the school records who drove each run. Sign-in used to hand back
     * only the token, so a driver saw his bus and was then told to sign in
     * before starting the run -- with the only other way to get a session
     * being a PIN endpoint, for a PIN nobody is ever issued.
     *
     * Defaulted, so a handset carrying this build still works against a server
     * that predates it. */
    @SerialName("session_token") val sessionToken: String = "",
    val vehicle: Vehicle,
    /** The driver's name, so the run screen can say who is signed in. */
    val driver: String? = null,
    /* THE ROUTES THIS BUS RUNS, decided by the office.
     *
     * routes.vehicle_id has been in the schema since the first migration, and
     * the app had no way to ask -- so it kept a route book the driver filled in
     * by hand, and what it asked them to type was a uuid, at twenty to seven in
     * the morning, off a piece of paper.
     *
     * Empty is not an error: a bus with no route yet still tracks, and the
     * parents still see it move. */
    val routes: List<AssignedRoute> = emptyList(),
)

@Serializable
data class AssignedRoute(
    val id: String,
    val name: String,
    val code: String = "",
)

@Serializable
data class SignInRequest(
    val phone: String,
    /* The driver's ordinary login. Sent as `password`; the server reads `pin`
       too, so an older server still accepts this. */
    val password: String,
)

@Serializable
data class SignInResponse(
    @SerialName("session_token") val sessionToken: String,
    /** The driver's name, for the screen to confirm who is signed in. */
    val name: String,
    /** RFC3339. The shift ends here whatever the app thinks. */
    @SerialName("expires_at") val expiresAt: String,
    /* The routes on this bus, refreshed every shift.
     *
     * They used to arrive only with the pairing, so a route the office added
     * afterwards never reached a phone that was already paired: the driver got
     * a box asking for a uuid under a sentence claiming the server does not
     * hand out routes. Defaulted, so an older server that sends none leaves
     * the stored book alone rather than emptying it. */
    val routes: List<AssignedRoute> = emptyList(),
)

@Serializable
data class SignOutResponse(
    @SerialName("signed_out") val signedOut: Boolean = true,
)

@Serializable
data class StartTripRequest(
    @SerialName("route_id") val routeId: String,
    /** `"pickup"` or `"drop"`; the server rejects anything else. */
    val direction: String,
    @SerialName("started_at") val startedAt: String,
    /**
     * Only ever set after the server has answered 409 `trip_already_open` and
     * the driver has confirmed. Sending it by default would let a phone that
     * woke up confused silently close the run a second bus is on.
     */
    val supersede: Boolean = false,
)

@Serializable
data class StartTripResponse(
    @SerialName("trip_id") val tripId: String,
    val stops: List<TripStop> = emptyList(),
)

@Serializable
data class TripStop(
    val id: String,
    val name: String,
    val sequence: Int,
    val latitude: Double? = null,
    val longitude: Double? = null,
    /** The radius the server will judge this arrival by. Sent so the app agrees. */
    @SerialName("geofence_m") val geofenceM: Int = 0,
    @SerialName("scheduled_at") val scheduledAt: String? = null,
)

@Serializable
data class EndTripRequest(
    @SerialName("ended_at") val endedAt: String,
    /** Always `"driver"` from this app. Only the sweeper writes `"timeout"`. */
    val reason: String = REASON_DRIVER,
) {
    companion object {
        const val REASON_DRIVER = "driver"
    }
}

@Serializable
data class EndTripResponse(val ended: Boolean = false)

// ---------------------------------------------------------------- positions

@Serializable
data class PositionFix(
    @SerialName("recorded_at") val recordedAt: String,
    val latitude: Double,
    val longitude: Double,
    @SerialName("speed_kmph") val speedKmph: Double? = null,
    @SerialName("heading_deg") val headingDeg: Int? = null,
    @SerialName("accuracy_m") val accuracyM: Double? = null,
)

@Serializable
data class PositionsRequest(
    @SerialName("trip_id") val tripId: String,
    val fixes: List<PositionFix>,
)

@Serializable
data class PositionsResponse(
    /**
     * The `recorded_at` values actually stored — a list, not a count. A count
     * cannot tell the phone *which* fix to stop retrying, so a partial accept
     * would become an all-or-nothing retry.
     */
    val accepted: List<String> = emptyList(),
    @SerialName("ping_seconds") val pingSeconds: Int? = null,
    val paused: Boolean = false,
    /** False means the server closed the run underneath us. Stop, and say so. */
    @SerialName("trip_open") val tripOpen: Boolean = true,
)

// ---------------------------------------------------------------- heartbeat

@Serializable
data class HeartbeatRequest(
    @SerialName("battery_pct") val batteryPct: Int,
    val charging: Boolean,
    /**
     * The field the office actually needs. False when the OS is not in fact
     * granting the location this app needs — that is the failure where the
     * phone is online, charged, and the bus is not on the map.
     */
    @SerialName("location_ok") val locationOk: Boolean,
    @SerialName("app_version") val appVersion: String,
)

@Serializable
data class HeartbeatResponse(
    @SerialName("ping_seconds") val pingSeconds: Int? = null,
    val paused: Boolean = false,
)

// ------------------------------------------------------------------- errors

/** The shape `httpx.Error` emits everywhere in this API: `{ error: { code, message } }`. */
@Serializable
data class ApiErrorBody(
    val error: ApiErrorDetail? = null,
    /** Carried alongside the error by `422 skewed_clock`, so the phone can say by how much. */
    @SerialName("server_time") val serverTime: String? = null,
    /** Carried by `429 too_fast`. Seconds to wait before pushing the same batch again. */
    @SerialName("retry_after") val retryAfter: Int? = null,
)

@Serializable
data class ApiErrorDetail(
    val code: String = "",
    val message: String = "",
)

object ErrorCodes {
    const val UNAUTHORIZED = "unauthorized"
    const val NO_SUCH_TRIP = "no_such_trip"
    const val TRIP_ALREADY_OPEN = "trip_already_open"
    const val SKEWED_CLOCK = "skewed_clock"
    const val TOO_FAST = "too_fast"
}
