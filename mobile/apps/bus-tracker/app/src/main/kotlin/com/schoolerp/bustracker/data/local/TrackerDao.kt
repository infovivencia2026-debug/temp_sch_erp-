package com.schoolerp.bustracker.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface FixDao {

    /**
     * IGNORE, not REPLACE. A second fix inside the same second is not new
     * information, and replacing would let a late, less accurate fix overwrite
     * the good one already buffered for that second.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(fix: FixEntity): Long

    /**
     * Oldest first, and capped by the caller at the contract's 200. Oldest
     * first matters: the dead-zone history is what is at risk, and uploading
     * the newest fix first would leave the tunnel unsent until the buffer
     * happened to be small enough to clear in one go.
     */
    @Query(
        "SELECT * FROM buffered_fix WHERE tripId = :tripId " +
            "ORDER BY recordedAtSeconds ASC LIMIT :limit",
    )
    suspend fun nextBatch(tripId: String, limit: Int): List<FixEntity>

    /**
     * Deletes only what the server named in `accepted`. This is the whole
     * bargain of the batch: an unacknowledged fix stays on disk and goes again,
     * so a partial accept costs a retry rather than a hole in the history.
     */
    @Query("DELETE FROM buffered_fix WHERE tripId = :tripId AND recordedAtSeconds IN (:seconds)")
    suspend fun deleteAcknowledged(tripId: String, seconds: List<Long>): Int

    @Query("SELECT COUNT(*) FROM buffered_fix WHERE tripId = :tripId")
    suspend fun countFor(tripId: String): Int

    @Query("SELECT COUNT(*) FROM buffered_fix")
    fun observeBufferDepth(): Flow<Int>

    /**
     * Fixes belonging to no open trip. A run that ended with its buffer
     * undrained leaves rows the server will never take: `no_such_trip` is not
     * retryable, and keeping them would mean the app uploads nothing else ever
     * again because the head of the queue is permanently stuck.
     */
    @Query("DELETE FROM buffered_fix WHERE tripId = :tripId")
    suspend fun discardTrip(tripId: String): Int

    @Query("SELECT DISTINCT tripId FROM buffered_fix")
    suspend fun bufferedTripIds(): List<String>
}

@Dao
interface StopDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun replaceAll(stops: List<StopEntity>)

    @Query("SELECT * FROM trip_stop WHERE tripId = :tripId ORDER BY sequence ASC")
    fun observeStops(tripId: String): Flow<List<StopEntity>>

    @Query("SELECT * FROM trip_stop WHERE tripId = :tripId ORDER BY sequence ASC")
    suspend fun stopsFor(tripId: String): List<StopEntity>

    @Query("UPDATE trip_stop SET arrivedAtMillis = :at WHERE tripId = :tripId AND stopId = :stopId AND arrivedAtMillis IS NULL")
    suspend fun markArrived(tripId: String, stopId: String, at: Long): Int

    @Query("DELETE FROM trip_stop WHERE tripId <> :keepTripId")
    suspend fun pruneOtherThan(keepTripId: String): Int

    @Query("DELETE FROM trip_stop")
    suspend fun clear()
}
