package com.schoolerp.smsgateway.core

/**
 * The 8-character code the admin console shows, as typed by a human on a phone
 * keypad in an office.
 *
 * Normalisation is deliberately shallow: upper-case, and drop the whitespace
 * and hyphens people insert into a grouped code. It does **not** fold `O` to
 * `0` or `I` to `1`, because the contract does not say which alphabet the
 * server draws codes from and a wrong fold would turn a valid code into a
 * mysterious pairing failure.
 */
object PairCode {

    const val LENGTH = 8

    fun normalise(raw: String): String =
        raw.filterNot { it.isWhitespace() || it == '-' || it == '_' }
            .uppercase()
            .take(LENGTH)

    fun isComplete(raw: String): Boolean = normalise(raw).length == LENGTH
}
