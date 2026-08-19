package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.engine.Backoff
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {

    @Test
    fun `delays grow and stay inside the ceiling`() {
        val backoff = Backoff(baseMillis = 1_000, maxMillis = 60_000, random = Random(7))
        val delays = List(12) { backoff.nextDelayMillis() }

        assertTrue("never instant", delays.all { it >= 1_000 })
        assertTrue("never unbounded", delays.all { it <= 60_000 })
        assertTrue("grows towards the ceiling", delays.max() > 10_000)
    }

    @Test
    fun `reset returns to the base`() {
        val backoff = Backoff(baseMillis = 1_000, maxMillis = 60_000, random = Random(7))
        repeat(10) { backoff.nextDelayMillis() }
        backoff.reset()
        assertTrue(backoff.nextDelayMillis() <= 2_000)
    }

    @Test
    fun `two gateways failing together do not retry in lockstep`() {
        // Full jitter: the same attempt number on two devices must not produce
        // the same delay, or a server restart is followed by a thundering herd.
        val a = Backoff(random = Random(1))
        val b = Backoff(random = Random(2))
        val fromA = List(6) { a.nextDelayMillis() }
        val fromB = List(6) { b.nextDelayMillis() }
        assertTrue("two devices must not share a retry schedule", fromA != fromB)
    }

    @Test
    fun `receipt backoff is bounded so a receipt is never abandoned`() {
        val delays = (0..40).map { Backoff.forReceiptAttempt(it, Random(3)) }
        assertTrue(delays.all { it in 5_000..30 * 60_000 })
    }
}
