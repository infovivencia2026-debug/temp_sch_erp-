package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.local.StudentEntity
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.engine.Headcount
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic behind "3 of 3, 2 absent". One function feeds the stop row,
 * the next-stop card and the notification; if it counted a child in bed as
 * somebody still to collect, all three would tell the driver to wait.
 */
class HeadcountTest {

    private fun child(
        id: String,
        status: String = "",
        absent: Boolean = false,
        pending: String? = null,
    ) = StudentEntity(
        tripId = "t1",
        studentId = id,
        name = "Child $id",
        admissionNo = "A-$id",
        className = "3 B",
        stopId = "st1",
        hasPhoto = false,
        absent = absent,
        absentReason = if (absent) "fever" else "",
        status = status,
        markedAt = "",
        pendingStatus = pending,
        pendingAtMillis = pending?.let { 1_000L },
    )

    @Test
    fun `a pickup counts boarded children and leaves reported absences out of expected`() {
        val count = Headcount.of(
            listOf(
                child("a", status = "boarded"),
                child("b", status = "boarded"),
                child("c"),
                child("d", absent = true),
                child("e", absent = true, status = "absent"),
            ),
            DIRECTION_PICKUP,
        )
        assertEquals(3, count.expected)
        assertEquals(2, count.done)
        assertEquals(2, count.reportedAbsent)
        assertEquals(0, count.markedAbsent)
        assertEquals(1, count.outstanding)
        assertFalse(count.complete)
        assertEquals("2 of 3 on, 2 reported absent", count.summary(DIRECTION_PICKUP))
    }

    @Test
    fun `a drop counts alighted children, and boarded is not done`() {
        val count = Headcount.of(
            listOf(
                child("a", status = "alighted"),
                child("b", status = "boarded"),
            ),
            DIRECTION_DROP,
        )
        assertEquals(2, count.expected)
        assertEquals(1, count.done)
        assertEquals(1, count.outstanding)
        assertEquals("1 of 2 off", count.summary(DIRECTION_DROP))
    }

    @Test
    fun `a driver's absent mark is counted apart from a reported absence and closes the stop`() {
        val count = Headcount.of(
            listOf(
                child("a", status = "boarded"),
                child("b", status = "absent"),
                child("c", absent = true),
            ),
            DIRECTION_PICKUP,
        )
        assertEquals(2, count.expected)
        assertEquals(1, count.done)
        assertEquals(1, count.markedAbsent)
        assertEquals(1, count.reportedAbsent)
        assertEquals(0, count.outstanding)
        assertTrue(count.complete)
        assertEquals("1 of 2 on, 1 absent, 1 reported absent", count.summary(DIRECTION_PICKUP))
    }

    @Test
    fun `the driver's pending tap beats the server's copy`() {
        val tapped = child("a", status = "", pending = "boarded")
        assertEquals("boarded", tapped.effectiveStatus)
        val untapped = child("b", status = "boarded")
        assertEquals("boarded", untapped.effectiveStatus)

        val count = Headcount.of(
            listOf(tapped, child("c", status = "boarded", pending = "absent")),
            DIRECTION_PICKUP,
        )
        assertEquals(1, count.done)
        assertEquals(1, count.markedAbsent)
        assertTrue(count.complete)
    }

    @Test
    fun `an empty stop is never complete`() {
        val count = Headcount.of(emptyList(), DIRECTION_PICKUP)
        assertEquals("0 of 0 on", count.summary(DIRECTION_PICKUP))
        assertFalse(count.complete)
    }
}
