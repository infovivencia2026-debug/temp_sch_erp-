package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.remote.ApiFailure
import com.schoolerp.bustracker.data.remote.ApiFailures
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every row of the contract's error table, driven directly. */
class ApiFailureTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private fun body(code: String, extra: String = "") =
        """{"error":{"code":"$code","message":"m"}$extra}"""

    @Test
    fun `401 unauthorized means re-pair, not retry`() {
        val failure = ApiFailures.from(json, 401, body("unauthorized"), null)
        assertTrue(failure is ApiFailure.Unauthorized)
        assertFalse(failure.isRetryable)
    }

    @Test
    fun `404 no_such_trip is not retryable`() {
        val failure = ApiFailures.from(json, 404, body("no_such_trip"), null)
        assertTrue(failure is ApiFailure.NoSuchTrip)
        // Retrying would wedge the head of the buffer forever and stop every
        // later fix behind it.
        assertFalse(failure.isRetryable)
    }

    @Test
    fun `409 trip_already_open carries the message the driver is shown`() {
        val failure = ApiFailures.from(json, 409, body("trip_already_open"), null)
        assertTrue(failure is ApiFailure.TripAlreadyOpen)
        assertEquals("m", (failure as ApiFailure.TripAlreadyOpen).detail)
    }

    @Test
    fun `422 skewed_clock names the server's time`() {
        val failure = ApiFailures.from(
            json,
            422,
            """{"error":{"code":"skewed_clock","message":"m"},"server_time":"2026-08-19T09:00:00Z"}""",
            null,
        )
        assertTrue(failure is ApiFailure.SkewedClock)
        assertEquals("2026-08-19T09:00:00Z", (failure as ApiFailure.SkewedClock).serverTime)
        assertFalse(failure.isRetryable)
    }

    @Test
    fun `429 too_fast prefers the body's retry_after over the header`() {
        // The contract names retry_after in the body. HTTP's own header is read
        // as a fallback, not as the authority, or the two would disagree on a
        // proxy that adds one.
        val failure = ApiFailures.from(json, 429, body("too_fast", ""","retry_after":45"""), 5)
        assertTrue(failure is ApiFailure.TooFast)
        assertEquals(45, (failure as ApiFailure.TooFast).retryAfterSeconds)
        assertTrue(failure.isRetryable)
    }

    @Test
    fun `429 falls back to the Retry-After header when the body says nothing`() {
        val failure = ApiFailures.from(json, 429, null, 12)
        assertEquals(12, (failure as ApiFailure.TooFast).retryAfterSeconds)
    }

    @Test
    fun `5xx is retryable because it is the server's problem`() {
        assertTrue(ApiFailures.from(json, 503, null, null).isRetryable)
    }

    @Test
    fun `an unrecognised 4xx is a contract mismatch and is not retried`() {
        val failure = ApiFailures.from(json, 418, """{"error":{"code":"teapot","message":"no"}}""", null)
        assertTrue(failure is ApiFailure.Rejected)
        assertFalse(failure.isRetryable)
    }

    @Test
    fun `a garbled error body still produces a usable failure`() {
        val failure = ApiFailures.from(json, 400, "<html>gateway timeout</html>", null)
        assertTrue(failure is ApiFailure.Rejected)
    }
}
