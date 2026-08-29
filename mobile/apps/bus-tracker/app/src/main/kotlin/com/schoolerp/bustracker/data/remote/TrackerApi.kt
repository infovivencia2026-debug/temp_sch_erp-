package com.schoolerp.bustracker.data.remote

import com.schoolerp.bustracker.core.BaseUrl
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import java.io.IOException

/**
 * Every call the phone makes, and nothing else. Paths come straight from
 * `docs/BUS_TRACKER_CONTRACT.md`.
 *
 * Note the direction: unlike the SMS gateway, which polls because the server
 * cannot reach a handset behind carrier-grade NAT, this app POSTs — the phone
 * is the one holding the data. Configuration comes back on those pushes rather
 * than in a call of its own.
 */
class TrackerApi(
    private val client: HttpClient,
    private val json: Json,
) {

    /** Unauthenticated. The only call made before the phone has a token. */
    suspend fun claim(baseUrl: BaseUrl, request: ClaimRequest): ClaimResponse =
        call {
            client.post(baseUrl.resolve(PATH_CLAIM)) {
                contentType(ContentType.Application.Json)
                setBody(request)
            }
        }

    /* SIGNING IN, which is what makes a trip possible at all.
     *
     * The server gates trip start and end on X-Staff-Session and this app never
     * obtained one, so both answered 401 not_signed_in and the Start button
     * failed on every handset in the field. Pairing was never the problem: a
     * paired phone reports position and heartbeat happily, which is why the
     * failure was invisible from the office.
     *
     * Bearer AND the body: the device token says which bus, the phone and PIN
     * say who is driving it. The server checks that the person belongs to the
     * same school the handset was paired to, so a valid PIN from another
     * school is still refused.
     */
    suspend fun signIn(
        baseUrl: BaseUrl,
        token: String,
        request: SignInRequest,
    ): SignInResponse = call {
        client.post(baseUrl.resolve(PATH_SESSION)) {
            bearer(token)
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    /* Ending the shift does NOT end an open trip, by the server's design: a
     * driver who signs out with the bus still moving has made a mistake, and
     * dropping the children off the parents' map is not how to correct it. */
    suspend fun signOut(
        baseUrl: BaseUrl,
        token: String,
    ): SignOutResponse = call {
        client.post(baseUrl.resolve(PATH_SESSION_END)) {
            bearer(token)
        }
    }

    suspend fun startTrip(
        baseUrl: BaseUrl,
        token: String,
        session: String,
        request: StartTripRequest,
    ): StartTripResponse = call {
        client.post(baseUrl.resolve(PATH_TRIPS)) {
            bearer(token)
            staffSession(session)
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    suspend fun endTrip(
        baseUrl: BaseUrl,
        token: String,
        session: String,
        tripId: String,
        request: EndTripRequest,
    ): EndTripResponse = call {
        client.post(baseUrl.resolve(pathEndTrip(tripId))) {
            bearer(token)
            staffSession(session)
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    suspend fun postPositions(
        baseUrl: BaseUrl,
        token: String,
        request: PositionsRequest,
    ): PositionsResponse {
        require(request.fixes.size <= MAX_FIXES_PER_PUSH) {
            "the contract caps a push at $MAX_FIXES_PER_PUSH fixes"
        }
        return call {
            client.post(baseUrl.resolve(PATH_POSITIONS)) {
                bearer(token)
                contentType(ContentType.Application.Json)
                setBody(request)
            }
        }
    }

    suspend fun heartbeat(
        baseUrl: BaseUrl,
        token: String,
        request: HeartbeatRequest,
    ): HeartbeatResponse = call {
        client.post(baseUrl.resolve(PATH_HEARTBEAT)) {
            bearer(token)
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    private suspend inline fun <reified T> call(block: () -> HttpResponse): T {
        val response = try {
            block()
        } catch (io: IOException) {
            throw ApiFailure.Network(io.javaClass.simpleName)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (other: Exception) {
            throw ApiFailure.Network(other.javaClass.simpleName)
        }

        val status = response.status.value
        if (status !in 200..299) {
            // Read the body once: the contract puts the discriminating code in
            // it, and status alone cannot tell no_such_trip from any other 404.
            val raw = runCatching { response.bodyAsText() }.getOrNull()
            throw ApiFailures.from(json, status, raw, response.headers[HttpHeaders.RetryAfter]?.toIntOrNull())
        }

        return try {
            response.body()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (parse: Exception) {
            throw ApiFailure.Malformed(parse.javaClass.simpleName)
        }
    }

    /**
     * Maps a failed response onto [ApiFailure]. Split out and internal so the
     * no-database tests can drive every row of the contract's error table
     * without an HTTP client.
     */
    private fun HttpRequestBuilder.bearer(token: String) {
        header(HttpHeaders.Authorization, "Bearer $token")
    }

    /* Its own header rather than a second Authorization, because the two
     * identify different things and the server reads them separately: the
     * bearer is the bus, this is the person. */
    private fun HttpRequestBuilder.staffSession(token: String) {
        header(HEADER_STAFF_SESSION, token)
    }

    companion object {
        const val PATH_CLAIM = "/api/v1/public/bus-tracker/claim"
        const val PATH_TRIPS = "/api/v1/bus-tracker/trips"
        const val PATH_POSITIONS = "/api/v1/bus-tracker/positions"
        const val PATH_HEARTBEAT = "/api/v1/bus-tracker/heartbeat"
        const val PATH_SESSION = "/api/v1/bus-tracker/session"
        const val PATH_SESSION_END = "/api/v1/bus-tracker/session/end"
        const val HEADER_STAFF_SESSION = "X-Staff-Session"

        fun pathEndTrip(tripId: String): String = "/api/v1/bus-tracker/trips/$tripId/end"

        /** The contract's own ceiling: "Up to 200 fixes per request." */
        const val MAX_FIXES_PER_PUSH = 200
    }
}
