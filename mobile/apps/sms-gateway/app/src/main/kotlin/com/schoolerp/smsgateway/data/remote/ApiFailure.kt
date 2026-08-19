package com.schoolerp.smsgateway.data.remote

/**
 * Why a call did not succeed, in the only terms the rest of the app cares
 * about: is it worth retrying, and does a human have to do something?
 */
sealed class ApiFailure(val reason: String) : Exception(reason) {

    /** No route to the server: flight mode, no data, DNS, TLS. Retry. */
    class Network(reason: String) : ApiFailure(reason)

    /** The token is gone or revoked. Retrying will never help — re-pair. */
    data object Unauthorized : ApiFailure("device_token_rejected")

    /** The server is asking us to slow down. [retryAfterSeconds] if it said so. */
    class RateLimited(val retryAfterSeconds: Int?) : ApiFailure("rate_limited")

    /** 5xx. The server's problem, and it will probably pass. Retry. */
    class Server(val status: Int) : ApiFailure("server_$status")

    /** 4xx that is not 401/429 — a contract mismatch. Retrying will not help. */
    class Rejected(val status: Int, val detail: String?) :
        ApiFailure("rejected_$status" + (detail?.let { ":$it" } ?: ""))

    /** The body did not parse. Almost always a contract drift. */
    class Malformed(detail: String) : ApiFailure("malformed_response:$detail")

    val isRetryable: Boolean
        get() = this is Network || this is Server || this is RateLimited
}
