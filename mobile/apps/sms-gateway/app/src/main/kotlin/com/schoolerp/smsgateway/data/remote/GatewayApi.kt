package com.schoolerp.smsgateway.data.remote

import com.schoolerp.smsgateway.core.BaseUrl
import io.ktor.client.HttpClient
import io.ktor.client.call.body
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
import java.io.IOException

/**
 * Every call the phone makes, and nothing else. Paths come straight from
 * `docs/SMS_GATEWAY_CONTRACT.md`.
 */
class GatewayApi(private val client: HttpClient) {

    /** Unauthenticated. The only call made before the phone has a token. */
    suspend fun claim(baseUrl: BaseUrl, request: ClaimRequest): ClaimResponse =
        call {
            client.post(baseUrl.resolve(PATH_CLAIM)) {
                contentType(ContentType.Application.Json)
                setBody(request)
            }
        }

    /** Also unauthenticated: the phone has no credential until this answers. */
    suspend fun enrol(baseUrl: BaseUrl, request: EnrolRequest): EnrolResponse =
        call {
            client.post(baseUrl.resolve(PATH_ENROL)) {
                contentType(ContentType.Application.Json)
                setBody(request)
            }
        }

    suspend fun outbox(baseUrl: BaseUrl, token: String, max: Int): OutboxResponse =
        call {
            client.get(baseUrl.resolve(PATH_OUTBOX)) {
                bearer(token)
                parameter("max", max)
            }
        }

    suspend fun receipts(
        baseUrl: BaseUrl,
        token: String,
        request: ReceiptsRequest,
    ): ReceiptsResponse = call {
        client.post(baseUrl.resolve(PATH_RECEIPTS)) {
            bearer(token)
            contentType(ContentType.Application.Json)
            setBody(request)
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

    /* The server's own error code, read out of the envelope.

       Reading the body of a refusal is normally the wrong instinct, since the
       status is the contract. This is the one case where it is not: a 403 that
       means "waiting for an administrator" and a 403 that means "this token is
       finished" call for opposite behaviour, and only the code tells them
       apart. Failure to parse falls through to the status, which is the safe
       direction: an unrecognised 403 stays a rejection. */
    private suspend fun bodyCode(response: HttpResponse): String? = runCatching {
        val body = response.bodyAsText()
        Regex("\"code\"\\s*:\\s*\"([a-z_]+)\"").find(body)?.groupValues?.get(1)
    }.getOrNull()

    private suspend inline fun <reified T> call(block: () -> HttpResponse): T {
        val response = try {
            block()
        } catch (io: IOException) {
            throw ApiFailure.Network(io.javaClass.simpleName)
        } catch (cancellation: kotlinx.coroutines.CancellationException) {
            throw cancellation
        } catch (other: Exception) {
            throw ApiFailure.Network(other.javaClass.simpleName)
        }

        val status = response.status.value
        when {
            status in 200..299 -> Unit
            /* Read the code, not just the status. A 403 carrying
               awaiting_approval means the office has not pressed Approve yet,
               which is a state to sit in rather than a credential to throw
               away. Every other 401 or 403 stays a rejection. */
            status == 403 && bodyCode(response) == "awaiting_approval" ->
                throw ApiFailure.AwaitingApproval
            status == 401 || status == 403 -> throw ApiFailure.Unauthorized
            status == 429 -> throw ApiFailure.RateLimited(
                response.headers[HttpHeaders.RetryAfter]?.toIntOrNull(),
            )
            status in 500..599 -> throw ApiFailure.Server(status)
            // The detail is a server-authored error code, never a message body.
            else -> throw ApiFailure.Rejected(status, runCatching { response.bodyAsText().take(200) }.getOrNull())
        }

        return try {
            response.body()
        } catch (cancellation: kotlinx.coroutines.CancellationException) {
            throw cancellation
        } catch (parse: Exception) {
            throw ApiFailure.Malformed(parse.javaClass.simpleName)
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.bearer(token: String) {
        header(HttpHeaders.Authorization, "Bearer $token")
    }

    companion object {
        const val PATH_CLAIM = "/api/v1/public/sms-gateway/claim"
        const val PATH_ENROL = "/api/v1/public/sms-gateway/enrol"
        const val PATH_OUTBOX = "/api/v1/sms-gateway/outbox"
        const val PATH_RECEIPTS = "/api/v1/sms-gateway/receipts"
        const val PATH_HEARTBEAT = "/api/v1/sms-gateway/heartbeat"

        /** The contract's own ceiling: `GET /outbox?max=20`. */
        const val MAX_OUTBOX_BATCH = 20
    }
}
