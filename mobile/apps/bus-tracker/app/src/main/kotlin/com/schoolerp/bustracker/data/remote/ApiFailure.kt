package com.schoolerp.bustracker.data.remote

import kotlinx.serialization.json.Json

/**
 * Why a call did not succeed, in the only terms the rest of the app cares
 * about: is it worth retrying, and does a human have to do something?
 */
sealed class ApiFailure(val reason: String) : Exception(reason) {

    /** No route to the server: a tunnel, a dead zone, DNS, TLS. Retry, and buffer. */
    class Network(reason: String) : ApiFailure(reason)

    /** The token is gone, revoked, or the server's key rotated. Re-pair. */
    data object Unauthorized : ApiFailure(ErrorCodes.UNAUTHORIZED)

    /** The trip is not this device's, or is already closed. Stop reporting to it. */
    data object NoSuchTrip : ApiFailure(ErrorCodes.NO_SUCH_TRIP)

    /**
     * A run is already open for this bus. The driver decides whether to
     * supersede.
     *
     * [detail] rather than `message`, which is Throwable's own property: a val
     * of that name here shadows it, and Kotlin refuses to compile it without an
     * override. Naming it `detail` also matches [Rejected] below, where it is
     * the same thing -- the server's sentence about why.
     */
    class TripAlreadyOpen(val detail: String?) : ApiFailure(ErrorCodes.TRIP_ALREADY_OPEN)

    /**
     * This phone's clock is more than a day from the server's. Not retryable:
     * the same fixes would be refused forever. [serverTime] is what the server
     * says the time is, so the screen can tell the driver by how much.
     */
    class SkewedClock(val serverTime: String?) : ApiFailure(ErrorCodes.SKEWED_CLOCK)

    /** Pushing faster than `ping_seconds` allows. Wait, then send the same batch. */
    class TooFast(val retryAfterSeconds: Int?) : ApiFailure(ErrorCodes.TOO_FAST)

    /** 5xx. The server's problem, and it will probably pass. Retry. */
    class Server(val status: Int) : ApiFailure("server_$status")

    /** Any other 4xx — a contract mismatch. Retrying will not help. */
    class Rejected(val status: Int, val code: String?, val detail: String?) :
        ApiFailure("rejected_$status" + (code?.let { ":$it" } ?: ""))

    /** The body did not parse. Almost always a contract drift. */
    class Malformed(detail: String) : ApiFailure("malformed_response:$detail")

    /**
     * Retryable means "send this same batch again later". Note what is not
     * here: [SkewedClock] and [NoSuchTrip]. Retrying either would wedge the
     * head of the buffer forever and stop every later fix behind it.
     */
    val isRetryable: Boolean
        get() = this is Network || this is Server || this is TooFast
}

/**
 * The contract's error table, in one place and free of any HTTP client, so the
 * no-database tests can drive every row of it directly.
 *
 * Status alone is not enough: a 404 could be a closed trip or a mistyped path,
 * and a 409 could be anything. The discriminating value is the `code` inside
 * `{ error: { code, message } }`, which is what this reads first.
 */
object ApiFailures {

    /**
     * [retryAfterHeader] is HTTP's own `Retry-After`. The contract's
     * `retry_after` in the body wins over it, because that is the one it names.
     */
    fun from(json: Json, status: Int, rawBody: String?, retryAfterHeader: Int?): ApiFailure {
        val parsed = rawBody?.let {
            runCatching { json.decodeFromString<ApiErrorBody>(it) }.getOrNull()
        }
        val code = parsed?.error?.code?.takeIf { it.isNotBlank() }

        return when {
            /* A WRONG PIN IS NOT A DEAD TOKEN.

               Both come back as 401, and folding them together left the
               screen unable to say which: "no PIN issued yet" and "wrong PIN"
               read as the same sentence. Only the sign-in endpoints answer
               with these codes, so carrying them through as a Rejected with
               the code changes nothing for the heartbeat or the push, whose
               401 is still Unauthorized. */
            status == 401 && (code == ErrorCodes.BAD_PIN || code == ErrorCodes.NO_LOGIN_YET) ->
                ApiFailure.Rejected(status, code, parsed?.error?.message)
            status == 401 || status == 403 -> ApiFailure.Unauthorized
            code == ErrorCodes.NO_SUCH_TRIP -> ApiFailure.NoSuchTrip
            code == ErrorCodes.TRIP_ALREADY_OPEN -> ApiFailure.TripAlreadyOpen(parsed?.error?.message)
            code == ErrorCodes.SKEWED_CLOCK -> ApiFailure.SkewedClock(parsed?.serverTime)
            code == ErrorCodes.TOO_FAST -> ApiFailure.TooFast(parsed?.retryAfter ?: retryAfterHeader)
            /* A 409 IS NOT ALWAYS A TRIP.
             *
               This blanket line read every 409 as "a run is already open",
               which is how a driver with no bus assigned to him was told that
               his bus had a run in progress. The server had said `no_vehicle`
               and said it clearly; the classifier threw the code away and kept
               the status, and then the sign-in screen could not match the
               shape it got and fell through to "Could not sign in
               (trip_already_open)" -- a sentence that sends the office looking
               for a stuck trip that has never existed.

               A 409 whose code this app does not recognise is now carried
               through with its code and the server's own sentence, which is
               always more use than a guess at what it meant. */
            status == 409 -> ApiFailure.Rejected(status, code, parsed?.error?.message)
            status == 429 -> ApiFailure.TooFast(parsed?.retryAfter ?: retryAfterHeader)
            // The only 422 this contract defines is the clock. Treating an
            // unlabelled one the same way is the safe read: both mean this
            // batch will never be accepted as it stands, and retrying it would
            // wedge every fix queued behind it.
            status == 422 -> ApiFailure.SkewedClock(parsed?.serverTime)
            status == 404 -> ApiFailure.NoSuchTrip
            status in 500..599 -> ApiFailure.Server(status)
            else -> ApiFailure.Rejected(status, code, parsed?.error?.message ?: rawBody?.take(200))
        }
    }
}
