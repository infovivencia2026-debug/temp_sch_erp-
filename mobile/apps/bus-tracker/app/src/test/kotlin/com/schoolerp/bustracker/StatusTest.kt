package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.prefs.ActiveTrip
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.device.LocationBlocker
import com.schoolerp.bustracker.engine.TrackerStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Reporting" has to mean the school can actually see the bus. Every case here
 * is one where a less strict reading would show a green screen over a missing
 * bus, which is the failure this whole app exists to remove.
 */
class StatusTest {

    private val trip = ActiveTrip("t1", "r1", "Morning", DIRECTION_PICKUP, 0L)

    private fun status(
        trip: ActiveTrip? = this.trip,
        blocker: LocationBlocker? = null,
        paused: Boolean = false,
        running: Boolean = true,
    ) = TrackerStatus(trip = trip, locationBlocker = blocker, pausedByServer = paused, serviceRunning = running)

    @Test
    fun `an open unblocked run with the service up is reporting`() {
        assertTrue(status().reporting)
    }

    @Test
    fun `no run means not reporting, however healthy the phone is`() {
        assertFalse(status(trip = null).reporting)
    }

    @Test
    fun `a phone the OS is not giving background location is not reporting`() {
        assertFalse(status(blocker = LocationBlocker.FOREGROUND_ONLY).reporting)
    }

    @Test
    fun `paused by the school is not reporting`() {
        assertFalse(status(paused = true).reporting)
    }

    @Test
    fun `a dead service is not reporting even with every permission granted`() {
        assertFalse(status(running = false).reporting)
    }

    @Test
    fun `the summary leads with the blocker, because that is what has to be fixed`() {
        assertEquals(
            LocationBlocker.LOCATION_OFF.headline,
            status(blocker = LocationBlocker.LOCATION_OFF).summary,
        )
    }

    @Test
    fun `a buffered backlog with no signal says nothing is lost`() {
        val summary = TrackerStatus(trip = trip, bufferedFixes = 42, hasNetwork = false, serviceRunning = true).summary
        assertTrue(summary.contains("42"))
        assertTrue(summary.contains("No signal"))
    }
}
