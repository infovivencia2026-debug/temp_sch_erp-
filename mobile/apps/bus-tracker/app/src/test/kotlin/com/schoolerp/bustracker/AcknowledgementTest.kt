package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.Rfc3339
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * The buffer may only forget what the server actually took. These tests are the
 * ones standing between a bus and a lost morning.
 */
class AcknowledgementTest {

    private val kolkata = ZoneId.of("Asia/Kolkata")

    @Test
    fun `an acknowledgement in the server's zone still matches the fix the phone sent`() {
        // The phone sends +05:30; the server answers in UTC. Comparing the two
        // as strings would acknowledge nothing, the buffer would never drain,
        // and the bus would re-upload its whole morning on every ping.
        val sentAtMillis = 1_755_600_125_000L
        val sent = Rfc3339.format(sentAtMillis, kolkata)
        assertTrue(sent.endsWith("+05:30"))

        val serverSaid = Rfc3339.format(sentAtMillis, ZoneId.of("UTC"))
        val acknowledged = Rfc3339.acknowledgedSeconds(listOf(serverSaid))

        assertTrue(Rfc3339.toEpochSecond(sentAtMillis) in acknowledged)
    }

    @Test
    fun `only the acknowledged fixes are forgotten`() {
        val first = 1_755_600_100_000L
        val second = 1_755_600_120_000L
        val acknowledged = Rfc3339.acknowledgedSeconds(listOf(Rfc3339.format(first, kolkata)))

        assertTrue(Rfc3339.toEpochSecond(first) in acknowledged)
        // A partial accept must leave the rest on disk. Deleting them because
        // the request as a whole succeeded is the hole in the history.
        assertTrue(Rfc3339.toEpochSecond(second) !in acknowledged)
    }

    @Test
    fun `an unparseable acknowledgement acknowledges nothing rather than everything`() {
        val acknowledged = Rfc3339.acknowledgedSeconds(listOf("not a timestamp", "2026-13-45"))
        assertTrue(acknowledged.isEmpty())
    }

    @Test
    fun `recorded_at is whole seconds so one ack cannot mean two fixes`() {
        // Go's time.RFC3339 has no sub-second part, so the acknowledgement comes
        // back truncated. Two buffered fixes inside one second would then both
        // match it, and one would be dropped unsent.
        val a = Rfc3339.format(1_755_600_125_400L, kolkata)
        val b = Rfc3339.format(1_755_600_125_900L, kolkata)
        assertEquals(a, b)
        assertTrue(!a.contains("."))
    }

    @Test
    fun `formatting carries an explicit offset, never a bare local time`() {
        val formatted = Rfc3339.format(1_755_600_125_000L, kolkata)
        assertTrue(
            "an offset-less timestamp cannot be placed on a timeline: $formatted",
            formatted.endsWith("Z") || formatted.contains("+") || formatted.count { it == '-' } > 2,
        )
    }
}
