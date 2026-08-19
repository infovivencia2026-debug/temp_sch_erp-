package com.schoolerp.bustracker.data.local

import androidx.room.Entity
import androidx.room.Index

/**
 * One GPS fix, written to disk before anything tries to upload it.
 *
 * The primary key is `(tripId, recordedAtSeconds)` — the same key the server's
 * unique index uses. That one fact carries most of the correctness here: a
 * retried batch cannot create a second row, a resumed service cannot duplicate
 * the second it was killed in, and an acknowledgement identifies exactly one
 * row to delete.
 *
 * Seconds, not milliseconds, because the acknowledgement comes back through
 * Go's `time.RFC3339`, which has no sub-second part. See [com.schoolerp
 * .bustracker.core.Rfc3339].
 */
@Entity(
    tableName = "buffered_fix",
    primaryKeys = ["tripId", "recordedAtSeconds"],
    indices = [Index(value = ["recordedAtSeconds"])],
)
data class FixEntity(
    val tripId: String,
    val recordedAtSeconds: Long,
    /** Exactly what goes on the wire, so the buffer and the request cannot drift. */
    val recordedAt: String,
    val latitude: Double,
    val longitude: Double,
    val speedKmph: Double?,
    val headingDeg: Int?,
    val accuracyM: Double?,
)
