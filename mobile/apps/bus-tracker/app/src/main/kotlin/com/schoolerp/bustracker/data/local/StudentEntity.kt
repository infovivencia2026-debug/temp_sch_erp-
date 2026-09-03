package com.schoolerp.bustracker.data.local

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/**
 * One child expected on the open run, as the server last described them, plus
 * the mark the driver made that the server has not yet been told about.
 *
 * Two columns for the mark, on purpose. [status] is what the server holds and
 * is overwritten on every roster refresh; [pendingStatus] is the driver's tap,
 * held on disk until the server names the child in `accepted`, exactly as a
 * fix is. A roster refresh from a dead zone therefore cannot undo a tap made
 * a minute ago, and a tap made a minute ago is never lost to a process death.
 */
@Entity(
    tableName = "trip_student",
    primaryKeys = ["tripId", "studentId"],
    indices = [Index(value = ["tripId", "stopId"])],
)
data class StudentEntity(
    val tripId: String,
    val studentId: String,
    val name: String,
    val admissionNo: String,
    val className: String,
    /** Empty when the allocation names no stop on this leg. */
    val stopId: String,
    val hasPhoto: Boolean,
    /** Somebody else's word: a parent's report or the class register. */
    val absent: Boolean,
    val absentReason: String,
    /** The server's record of today's mark: boarded, alighted, absent, or empty. */
    val status: String,
    val markedAt: String,
    val pendingStatus: String? = null,
    val pendingAtMillis: Long? = null,
) {
    /** What the driver sees: their own latest tap wins over the server's copy. */
    val effectiveStatus: String get() = pendingStatus ?: status
}

@Dao
interface StudentDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(students: List<StudentEntity>)

    @Query("SELECT * FROM trip_student WHERE tripId = :tripId AND studentId = :studentId")
    suspend fun find(tripId: String, studentId: String): StudentEntity?

    @Query("SELECT * FROM trip_student WHERE tripId = :tripId ORDER BY name")
    fun observe(tripId: String): Flow<List<StudentEntity>>

    @Query("SELECT * FROM trip_student WHERE tripId = :tripId AND pendingStatus IS NOT NULL ORDER BY pendingAtMillis")
    suspend fun pending(tripId: String): List<StudentEntity>

    @Query("SELECT COUNT(*) FROM trip_student WHERE pendingStatus IS NOT NULL")
    fun observePendingCount(): Flow<Int>

    @Query(
        "UPDATE trip_student SET pendingStatus = :status, pendingAtMillis = :at " +
            "WHERE tripId = :tripId AND studentId = :studentId",
    )
    suspend fun mark(tripId: String, studentId: String, status: String, at: Long): Int

    /**
     * The server took the mark: it becomes the record and the pending slot
     * clears, unless a newer tap landed in the meantime, in which case the
     * newer tap stays pending and goes on the next push.
     */
    @Query(
        "UPDATE trip_student SET status = pendingStatus, pendingStatus = NULL, pendingAtMillis = NULL " +
            "WHERE tripId = :tripId AND studentId = :studentId AND pendingAtMillis = :at",
    )
    suspend fun settle(tripId: String, studentId: String, at: Long): Int

    @Query("DELETE FROM trip_student WHERE tripId <> :keepTripId")
    suspend fun pruneOtherThan(keepTripId: String): Int

    @Query("DELETE FROM trip_student WHERE tripId = :tripId AND studentId NOT IN (:keep)")
    suspend fun deleteNotIn(tripId: String, keep: List<String>): Int

    @Query("DELETE FROM trip_student")
    suspend fun clear()

    /**
     * Replaces what the server said while keeping what the driver did. A
     * child the server no longer lists is dropped; a child it lists is
     * rewritten, but their pending tap survives the rewrite.
     */
    @Transaction
    suspend fun mergeRoster(tripId: String, fresh: List<StudentEntity>) {
        if (fresh.isEmpty()) {
            deleteNotIn(tripId, listOf(""))
            return
        }
        deleteNotIn(tripId, fresh.map { it.studentId })
        val merged = fresh.map { incoming ->
            val existing = find(tripId, incoming.studentId)
            if (existing?.pendingStatus != null) {
                incoming.copy(
                    pendingStatus = existing.pendingStatus,
                    pendingAtMillis = existing.pendingAtMillis,
                )
            } else {
                incoming
            }
        }
        insertAll(merged)
    }
}
