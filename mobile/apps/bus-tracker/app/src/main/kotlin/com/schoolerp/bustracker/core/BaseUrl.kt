package com.schoolerp.bustracker.core

/**
 * The school's server address, validated once so no other code has to wonder.
 *
 * HTTPS is not negotiable in a release build. A tracker carrying a bearer token
 * and a live stream of where a bus full of children is, over plain HTTP on a
 * mobile network, is both a credential and a child-safety leak handed to
 * whoever runs the network. `http://` is accepted only when
 * the build is a debug build *and* the operator has switched on the developer
 * flag, which exists so a developer can point at a laptop on the LAN.
 */
@JvmInline
value class BaseUrl private constructor(val value: String) {

    /** Joins a contract path such as `/api/v1/bus-tracker/positions`. */
    fun resolve(path: String): String = value + "/" + path.trimStart('/')

    override fun toString(): String = value

    companion object {

        fun parse(raw: String, allowInsecureHttp: Boolean): Result<BaseUrl> {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) {
                return Result.failure(BaseUrlError("Enter the school's server address."))
            }

            val lower = trimmed.lowercase()
            val scheme = lower.substringBefore("://", missingDelimiterValue = "")
            if (scheme.isEmpty()) {
                return Result.failure(
                    BaseUrlError("Start the address with https://, for example https://school.example.in"),
                )
            }
            if (scheme != "https" && scheme != "http") {
                return Result.failure(BaseUrlError("Only https:// addresses are supported."))
            }
            if (scheme == "http" && !allowInsecureHttp) {
                return Result.failure(
                    BaseUrlError(
                        "Plain http:// is refused. The device token and every message would " +
                            "travel unencrypted. Use https://.",
                    ),
                )
            }

            val authority = trimmed.substringAfter("://").substringBefore('/')
            if (authority.isEmpty() || authority.startsWith(":")) {
                return Result.failure(BaseUrlError("That address has no host name."))
            }
            if (authority.contains(' ')) {
                return Result.failure(BaseUrlError("That address contains a space."))
            }

            return Result.success(BaseUrl(trimmed))
        }
    }
}

class BaseUrlError(override val message: String) : IllegalArgumentException(message)
