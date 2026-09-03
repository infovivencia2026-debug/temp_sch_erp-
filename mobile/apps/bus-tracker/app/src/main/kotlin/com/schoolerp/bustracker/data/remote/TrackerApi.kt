package com.schoolerp.bustracker.data.remote

import com.schoolerp.bustracker.core.BaseUrl
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
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
    /* The driver's own way in. No pair code, no session: the PIN is the
     * credential, and the server answers with the bus HR has this person
     * against. See internal/api/bus_driver_signin.go. */
    /* Enrolling this handset against a scanned bus. Same shape as
     * driverSignIn: no session, the credential is in the body, and the server
     * answers with the vehicle it matched. */
    suspend fun enrol(
        baseUrl: BaseUrl,
        request: EnrolRequest,
    ): DriverSignInResponse = call {
        client.post(baseUrl.resolve(PATH_ENROL)) {
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    suspend fun driverSignIn(
        baseUrl: BaseUrl,
        request: DriverSignInRequest,
    ): DriverSignInResponse = call {
        client.post(baseUrl.resolve(PATH_DRIVER_SIGNIN)) {
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

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

    /** The lines the office has put on this bus. Device-authenticated: naming
     *  a bus is not naming a person, and this is asked before anybody signs in. */
    suspend fun routesForBus(
        baseUrl: BaseUrl,
        token: String,
        busCode: String,
    ): BusRoutesResponse = call {
        client.get(baseUrl.resolve(PATH_ROUTES)) {
            bearer(token)
            parameter("bus", busCode)
        }
    }

    /** The children this run stops for, in the order the bus reaches them. */
    suspend fun roll(
        baseUrl: BaseUrl,
        token: String,
        tripId: String,
    ): RollResponse = call {
        client.get(baseUrl.resolve(pathRoll(tripId))) { bearer(token) }
    }

    /** One child, marked on or off by the driver who watched them do it. */
    suspend fun markChild(
        baseUrl: BaseUrl,
        token: String,
        session: String,
        tripId: String,
        request: MarkChildRequest,
    ): Unit = call {
        client.post(baseUrl.resolve(pathRoll(tripId))) {
            bearer(token)
            staffSession(session)
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    suspend fun recordCheck(
        baseUrl: BaseUrl,
        token: String,
        session: String,
        request: TripCheckRequest,
    ): TripCheckResponse = call {
        client.post(baseUrl.resolve(PATH_CHECKS)) {
            bearer(token)
            staffSession(session)
            contentType(ContentType.Application.Json)
            setBody(request)
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

    // ---------------------------------------------------------- the children

    suspend fun roster(baseUrl: BaseUrl, token: String, session: String?, tripId: String): RosterResponse =
        call {
            client.get(baseUrl.resolve(pathRoster(tripId))) {
                bearer(token)
                session?.let { staffSession(it) }
            }
        }

    suspend fun postBoarding(
        baseUrl: BaseUrl,
        token: String,
        session: String?,
        tripId: String,
        request: BoardingRequest,
    ): BoardingResponse = call {
        client.post(baseUrl.resolve(pathBoarding(tripId))) {
            bearer(token)
            session?.let { staffSession(it) }
            contentType(ContentType.Application.Json)
            setBody(request)
        }
    }

    /** The bytes of a child's photo, or null for a child who has none. */
    suspend fun studentPhoto(baseUrl: BaseUrl, token: String, studentId: String): ByteArray? {
        val response = try {
            client.get(baseUrl.resolve(pathStudentPhoto(studentId))) { bearer(token) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (other: Exception) {
            throw ApiFailure.Network(other.javaClass.simpleName)
        }
        if (response.status.value == 404) return null
        if (response.status.value !in 200..299) {
            throw ApiFailures.from(json, response.status.value, null, null)
        }
        return response.body<ByteArray>()
    }

    suspend fun ackNotice(baseUrl: BaseUrl, token: String, session: String?, noticeId: String): AckResponse =
        call {
            client.post(baseUrl.resolve(pathAckNotice(noticeId))) {
                bearer(token)
                session?.let { staffSession(it) }
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
        const val PATH_ENROL = "/api/v1/public/bus-tracker/enrol"
        const val PATH_TRIPS = "/api/v1/bus-tracker/trips"
        const val PATH_ROUTES = "/api/v1/bus-tracker/routes"
        const val PATH_CHECKS = "/api/v1/bus-tracker/checks"
        fun pathRoll(tripId: String) = "$PATH_TRIPS/$tripId/roll"
        const val PATH_POSITIONS = "/api/v1/bus-tracker/positions"
        const val PATH_HEARTBEAT = "/api/v1/bus-tracker/heartbeat"
        const val PATH_DRIVER_SIGNIN = "/api/v1/public/bus-tracker/driver-signin"
        const val PATH_SESSION = "/api/v1/bus-tracker/session"
        const val PATH_SESSION_END = "/api/v1/bus-tracker/session/end"
        const val HEADER_STAFF_SESSION = "X-Staff-Session"

        fun pathEndTrip(tripId: String): String = "/api/v1/bus-tracker/trips/$tripId/end"
        fun pathRoster(tripId: String): String = "/api/v1/bus-tracker/trips/$tripId/roster"
        fun pathBoarding(tripId: String): String = "/api/v1/bus-tracker/trips/$tripId/boarding"
        fun pathStudentPhoto(studentId: String): String = "/api/v1/bus-tracker/students/$studentId/photo"
        fun pathAckNotice(noticeId: String): String = "/api/v1/bus-tracker/notices/$noticeId/ack"

        /** The contract's own ceiling: "Up to 200 fixes per request." */
        const val MAX_FIXES_PER_PUSH = 200
    }
}
