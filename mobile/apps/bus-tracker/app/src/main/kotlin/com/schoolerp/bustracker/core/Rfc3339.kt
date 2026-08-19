package com.schoolerp.bustracker.core

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** Injected so the buffer, the cadence and the skew guard are testable without sleeping. */
fun interface TimeSource {
    fun nowMillis(): Long
}

object SystemTimeSource : TimeSource {
    override fun nowMillis(): Long = System.currentTimeMillis()
}

/**
 * `recorded_at` on the wire, and the one place that knows how to compare one.
 *
 * The contract pins the format — RFC 3339 with an offset, e.g.
 * `2026-08-19T14:32:05+05:30` — and pins the meaning: the moment the phone took
 * the fix, never the moment it uploaded. Filing buffered fixes at receive time
 * draws a straight line out of the dead zone the bus actually crawled through.
 */
object Rfc3339 {

    /**
     * Whole seconds, deliberately.
     *
     * The server round-trips `recorded_at` through Go's `time.RFC3339`, which
     * has no sub-second component, so a fix recorded at `…:05.400` comes back
     * acknowledged as `…:05`. Two fixes inside one second would then both match
     * one acknowledgement and one of them would be deleted unsent, or kept and
     * retried forever. Truncating here makes each buffered fix's second unique
     * and the acknowledgement unambiguous — and the server's own unique index
     * on (trip_id, recorded_at) works to the same resolution anyway.
     */
    fun format(epochMillis: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(
            ZonedDateTime.ofInstant(Instant.ofEpochSecond(epochMillis / 1000), zone),
        )

    /** Null rather than an exception: an unparseable ack is a contract drift, not a crash. */
    fun parseToEpochSeconds(value: String): Long? =
        try {
            ZonedDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toEpochSecond()
        } catch (_: DateTimeParseException) {
            null
        }

    /**
     * Which buffered fixes the server actually stored.
     *
     * Matched on the instant, never on the string. The server formats the
     * acknowledgement in *its* zone, so a fix the phone sent as
     * `2026-08-19T14:32:05+05:30` can come back as `2026-08-19T09:02:05Z`.
     * Comparing text would ack nothing, the buffer would never drain, and the
     * bus would re-upload its whole morning every ping.
     */
    fun acknowledgedSeconds(accepted: List<String>): Set<Long> =
        accepted.mapNotNull(::parseToEpochSeconds).toSet()

    fun toEpochSecond(epochMillis: Long): Long = epochMillis / 1000
}

/** The contract's rejection window: a fix further than this from server time is refused. */
const val MAX_CLOCK_SKEW_MILLIS: Long = 24L * 60 * 60 * 1000
