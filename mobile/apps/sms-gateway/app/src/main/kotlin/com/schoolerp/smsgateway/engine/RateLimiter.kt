package com.schoolerp.smsgateway.engine

import com.schoolerp.smsgateway.core.TimeSource
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.ArrayDeque

/**
 * A sliding one-minute window over sends.
 *
 * The point is not tidiness. An Indian carrier watching a personal SIM emit a
 * few hundred messages in a burst will throttle it, and then disconnect it, and
 * the school loses its gateway on the morning it most needed one. The server
 * sets the cap; this obeys it rather than deciding for itself.
 *
 * It is seeded from the database on start, so restarting the service — or the
 * phone — cannot be used to buy a fresh minute's allowance.
 */
class RateLimiter(
    private val timeSource: TimeSource,
    private val windowMillis: Long = 60_000L,
) {

    private val mutex = Mutex()
    private val recent = ArrayDeque<Long>()

    /** Replays timestamps of sends already made, from durable storage. */
    suspend fun seed(timestamps: List<Long>) = mutex.withLock {
        recent.clear()
        val cutoff = timeSource.nowMillis() - windowMillis
        timestamps.filter { it >= cutoff }.sorted().forEach { recent.addLast(it) }
    }

    /** Millis to wait before a send would be within the cap. 0 if it already is. */
    suspend fun waitMillis(maxPerMinute: Int): Long = mutex.withLock {
        computeWait(maxPerMinute)
    }

    /**
     * Suspends until a slot is free, then records the send. Recording happens
     * under the same lock as the check, so concurrent dispatchers cannot both
     * squeeze through the last slot.
     */
    suspend fun acquire(maxPerMinute: Int) {
        while (true) {
            val wait = mutex.withLock {
                val w = computeWait(maxPerMinute)
                if (w == 0L) {
                    recent.addLast(timeSource.nowMillis())
                    return
                }
                w
            }
            delay(wait)
        }
    }

    /** Sends already counted in the current window. */
    suspend fun used(): Int = mutex.withLock {
        prune()
        recent.size
    }

    private fun computeWait(maxPerMinute: Int): Long {
        prune()
        val cap = maxPerMinute.coerceAtLeast(1)
        if (recent.size < cap) return 0L
        // The oldest send in the window is the one whose expiry frees a slot.
        val oldest = recent.peekFirst() ?: return 0L
        return (oldest + windowMillis - timeSource.nowMillis()).coerceAtLeast(1L)
    }

    private fun prune() {
        val cutoff = timeSource.nowMillis() - windowMillis
        while (true) {
            val oldest = recent.peekFirst() ?: return
            // `>` not `>=`: a send made exactly one window ago has left the
            // window. Treating it as still inside costs an extra millisecond of
            // waiting on every single send once the cap is reached.
            if (oldest > cutoff) return
            recent.removeFirst()
        }
    }
}
