package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.remote.TrackerApi
import com.schoolerp.bustracker.data.prefs.TrackerSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two numbers the server owns and the phone must not exceed or invent.
 */
class BatchingTest {

    @Test
    fun `the push cap is the contract's 200`() {
        assertEquals(200, TrackerApi.MAX_FIXES_PER_PUSH)
    }

    @Test
    fun `an hour in a dead zone at the fastest cadence still fits in whole batches`() {
        // 5 s is the contract's floor, so an hour of buffering is 720 fixes:
        // four pushes. The engine loops immediately while the buffer drains
        // rather than waiting a ping between them.
        val fixesInAnHour = 3600 / TrackerSettings.MIN_PING_SECONDS
        val pushes = (fixesInAnHour + TrackerApi.MAX_FIXES_PER_PUSH - 1) / TrackerApi.MAX_FIXES_PER_PUSH
        assertEquals(4, pushes)
    }

    @Test
    fun `the ping range is the contract's five to three hundred seconds`() {
        assertEquals(5, TrackerSettings.MIN_PING_SECONDS)
        assertEquals(300, TrackerSettings.MAX_PING_SECONDS)
        assertTrue(TrackerSettings.DEFAULT_PING_SECONDS in TrackerSettings.MIN_PING_SECONDS..TrackerSettings.MAX_PING_SECONDS)
    }

    @Test
    fun `a server directive outside the range is clamped, not obeyed literally`() {
        // A zero would be a fix every millisecond and a flat battery by ten.
        assertEquals(TrackerSettings.MIN_PING_SECONDS, TrackerSettings.clampPing(0))
        assertEquals(TrackerSettings.MIN_PING_SECONDS, TrackerSettings.clampPing(-1))
        assertEquals(TrackerSettings.MAX_PING_SECONDS, TrackerSettings.clampPing(99_999))
        assertEquals(30, TrackerSettings.clampPing(30))
    }
}
