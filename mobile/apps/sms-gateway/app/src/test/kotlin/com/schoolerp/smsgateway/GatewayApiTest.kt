package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.BaseUrl
import com.schoolerp.smsgateway.data.remote.ApiFailure
import com.schoolerp.smsgateway.data.remote.GatewayApi
import com.schoolerp.smsgateway.data.remote.Receipt
import com.schoolerp.smsgateway.data.remote.ReceiptsRequest
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GatewayApiTest {

    private val baseUrl = BaseUrl.parse("https://school.example.in", false).getOrThrow()

    private fun apiReturning(
        status: HttpStatusCode,
        body: String,
        capture: MutableList<io.ktor.client.request.HttpRequestData> = mutableListOf(),
    ): GatewayApi {
        val engine = MockEngine { request ->
            capture += request
            if (status.value in 200..299) {
                respond(body, status, headersOf("Content-Type", ContentType.Application.Json.toString()))
            } else {
                respondError(status, body)
            }
        }
        val client = HttpClient(engine) {
            expectSuccess = false
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        }
        return GatewayApi(client)
    }

    @Test
    fun `the outbox call uses the contract path, the max parameter and a bearer token`() = runTest {
        val requests = mutableListOf<io.ktor.client.request.HttpRequestData>()
        val api = apiReturning(HttpStatusCode.OK, """{"messages":[],"poll_seconds":30}""", requests)

        api.outbox(baseUrl, "tok_abc", 20)

        val request = requests.single()
        assertEquals("/api/v1/sms-gateway/outbox", request.url.encodedPath)
        assertEquals("20", request.url.parameters["max"])
        assertEquals("Bearer tok_abc", request.headers["Authorization"])
    }

    @Test
    fun `the claim call is the only one sent without a token`() = runTest {
        val requests = mutableListOf<io.ktor.client.request.HttpRequestData>()
        val api = apiReturning(
            HttpStatusCode.OK,
            """{"device_id":"d","device_token":"t","institution":"School"}""",
            requests,
        )

        api.claim(baseUrl, com.schoolerp.smsgateway.data.remote.ClaimRequest("ABCD1234", "Phone", "Android", null))

        val request = requests.single()
        assertEquals("/api/v1/public/sms-gateway/claim", request.url.encodedPath)
        assertEquals(null, request.headers["Authorization"])
    }

    @Test
    fun `a rejected token becomes Unauthorized, which is not retryable`() = runTest {
        val api = apiReturning(HttpStatusCode.Unauthorized, "nope")
        try {
            api.outbox(baseUrl, "stale", 20)
            fail("expected a failure")
        } catch (failure: ApiFailure) {
            assertEquals(ApiFailure.Unauthorized, failure)
            assertTrue(!failure.isRetryable)
        }
    }

    @Test
    fun `a 429 carries the server's Retry-After and is retryable`() = runTest {
        val engine = MockEngine {
            respond("slow down", HttpStatusCode.TooManyRequests, headersOf("Retry-After", "45"))
        }
        val api = GatewayApi(HttpClient(engine) { expectSuccess = false })

        try {
            api.outbox(baseUrl, "tok", 20)
            fail("expected a failure")
        } catch (failure: ApiFailure.RateLimited) {
            assertEquals(45, failure.retryAfterSeconds)
            assertTrue(failure.isRetryable)
        }
    }

    @Test
    fun `a 500 is retryable because it is the server's problem, not ours`() = runTest {
        val api = apiReturning(HttpStatusCode.InternalServerError, "boom")
        try {
            api.receipts(baseUrl, "tok", ReceiptsRequest(listOf(Receipt("m1", "sent", "2026-08-19T10:00:00+05:30"))))
            fail("expected a failure")
        } catch (failure: ApiFailure) {
            assertTrue(failure is ApiFailure.Server)
            assertTrue(failure.isRetryable)
        }
    }

    @Test
    fun `a reply that does not match the contract is reported as malformed`() = runTest {
        val api = apiReturning(HttpStatusCode.OK, """{"messages":"not-a-list"}""")
        try {
            api.outbox(baseUrl, "tok", 20)
            fail("expected a failure")
        } catch (failure: ApiFailure) {
            assertTrue(failure is ApiFailure.Malformed)
            assertTrue(!failure.isRetryable)
        }
    }

    @Test
    fun `receipts are posted to the contract path`() = runTest {
        val requests = mutableListOf<io.ktor.client.request.HttpRequestData>()
        val api = apiReturning(HttpStatusCode.OK, """{"accepted":1}""", requests)

        val response = api.receipts(
            baseUrl,
            "tok",
            ReceiptsRequest(listOf(Receipt("m1", Receipt.STATUS_SENT, "2026-08-19T10:00:00+05:30"))),
        )

        assertEquals(1, response.accepted)
        assertEquals("/api/v1/sms-gateway/receipts", requests.single().url.encodedPath)
    }
}
