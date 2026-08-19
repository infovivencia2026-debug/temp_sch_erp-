package com.schoolerp.smsgateway.core

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Injected so the rate limiter and the day rollover are testable without sleeping. */
fun interface TimeSource {
    fun nowMillis(): Long
}

object SystemTimeSource : TimeSource {
    override fun nowMillis(): Long = System.currentTimeMillis()
}

/**
 * `sent_at` on the wire. The contract does not pin a format, so this sends
 * RFC 3339 with an explicit offset — the one format every JSON/Go/Postgres
 * stack on the other end parses without argument. A bare local timestamp from
 * a handset whose clock zone the school does not control would be unusable.
 */
fun Long.toRfc3339(): String =
    DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(
        ZonedDateTime.ofInstant(Instant.ofEpochMilli(this), ZoneId.systemDefault()),
    )

/**
 * Local midnight, for "sent today". The school reads this number next to a
 * wall clock, so the handset's own zone is the right one.
 */
fun startOfLocalDay(nowMillis: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
    Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate().atStartOfDay(zone)
        .toInstant().toEpochMilli()
