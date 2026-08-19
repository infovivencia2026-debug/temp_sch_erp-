package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.TimeSource
import com.schoolerp.smsgateway.engine.RateLimiter
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RateLimiterTest {

    @Test
    fun `sends up to the cap without waiting`() = runTest {
        val limiter = RateLimiter(TimeSource { testScheduler.currentTime })

        repeat(5) { limiter.acquire(maxPerMinute = 5) }

        assertEquals("nothing should have been delayed", 0L, testScheduler.currentTime)
        assertEquals(5, limiter.used())
    }

    @Test
    fun `the send past the cap waits for the window to roll`() = runTest {
        val limiter = RateLimiter(TimeSource { testScheduler.currentTime })
        repeat(5) { limiter.acquire(maxPerMinute = 5) }

        limiter.acquire(maxPerMinute = 5)

        // The oldest send was at t=0, so a slot frees at t=60_000.
        assertEquals(60_000L, testScheduler.currentTime)
    }

    @Test
    fun `restarting the service does not buy a fresh minute`() = runTest {
        // A phone that was rebooted mid-campaign must not hand the carrier
        // another full minute's worth of messages the moment it comes back.
        val limiter = RateLimiter(TimeSource { testScheduler.currentTime })
        limiter.seed(listOf(0L, 1L, 2L, 3L, 4L))

        assertEquals(5, limiter.used())
        assertTrue(limiter.waitMillis(maxPerMinute = 5) > 0)
    }

    @Test
    fun `sends older than the window stop counting`() = runTest {
        val limiter = RateLimiter(TimeSource { testScheduler.currentTime })
        limiter.seed(listOf(-90_000L, -70_000L, 0L))

        assertEquals("only the send inside the window counts", 1, limiter.used())
    }

    @Test
    fun `a cap of zero is treated as one rather than deadlocking`() = runTest {
        val limiter = RateLimiter(TimeSource { testScheduler.currentTime })
        limiter.acquire(maxPerMinute = 0)
        assertEquals(0L, testScheduler.currentTime)
    }
}
