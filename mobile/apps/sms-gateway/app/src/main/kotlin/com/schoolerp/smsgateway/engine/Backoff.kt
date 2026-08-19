package com.schoolerp.smsgateway.engine

import kotlin.math.min
import kotlin.random.Random

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Every gateway phone for every school on one server
 * will fail at the same moment when that server restarts, and without jitter
 * they all come back in the same second and knock it over again.
 */
class Backoff(
    private val baseMillis: Long = 2_000L,
    private val maxMillis: Long = 5 * 60_000L,
    private val random: Random = Random.Default,
) {
    private var attempt = 0

    fun reset() {
        attempt = 0
    }

    fun nextDelayMillis(): Long {
        val ceiling = min(maxMillis, baseMillis shl min(attempt, 30))
        attempt++
        // Full jitter: uniform in [base, ceiling]. Never zero, so a tight
        // failure loop can never become a busy loop.
        return if (ceiling <= baseMillis) baseMillis
        else baseMillis + random.nextLong(ceiling - baseMillis + 1)
    }

    /** The delay a receipt's Nth attempt should wait, without holding state. */
    companion object {
        fun forReceiptAttempt(attempt: Int, random: Random = Random.Default): Long {
            val ceiling = min(30 * 60_000L, 5_000L shl min(attempt, 20))
            return 5_000L + random.nextLong((ceiling - 5_000L).coerceAtLeast(1L))
        }
    }
}
