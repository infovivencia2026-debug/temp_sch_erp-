package com.schoolerp.smsgateway.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {

    /**
     * IGNORE, not REPLACE. If the server re-delivers an id we already hold —
     * because our receipt was lost, or a lease expired while the SMS was in
     * flight — replacing would reset a `SENT` row to `QUEUED` and send the
     * message a second time. Ignoring keeps the first outcome, and the pending
     * receipt for it goes out again.
     *
     * The returned row ids are -1 for every row that was ignored.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnoringKnown(rows: List<MessageEntity>): List<Long>

    @Query("SELECT * FROM queued_message WHERE id = :id")
    suspend fun byId(id: String): MessageEntity?

    @Query(
        "SELECT * FROM queued_message WHERE state = 'QUEUED' " +
            "ORDER BY claimedAt ASC, id ASC LIMIT :limit",
    )
    suspend fun nextQueued(limit: Int): List<MessageEntity>

    @Query(
        "UPDATE queued_message SET state = 'SENDING', sendStartedAt = :now, " +
            "parts = :parts, partsPending = :parts WHERE id = :id AND state = 'QUEUED'",
    )
    suspend fun markSending(id: String, parts: Int, now: Long): Int

    /**
     * One segment's sent-result came back. Decrements the outstanding count and
     * records the first failure reason seen; the caller settles the row when
     * the count reaches zero.
     */
    @Query(
        "UPDATE queued_message SET partsPending = MAX(partsPending - 1, 0), " +
            "error = COALESCE(error, :error) WHERE id = :id AND state = 'SENDING'",
    )
    suspend fun recordPartResult(id: String, error: String?): Int

    @Query("SELECT partsPending FROM queued_message WHERE id = :id AND state = 'SENDING'")
    suspend fun partsPending(id: String): Int?

    /**
     * The outcome is final and the text is no longer needed, so it goes. The
     * row that remains is an id, a time and a result — enough for the status
     * screen and the receipt, and nothing a stranger could read.
     */
    @Query(
        "UPDATE queued_message SET state = :state, sentAt = :sentAt, error = :error, " +
            "bodyRaw = '', nextReceiptAt = 0 WHERE id = :id",
    )
    suspend fun settle(id: String, state: MessageState, sentAt: Long, error: String?): Int

    @Query("UPDATE queued_message SET delivered = :delivered WHERE id = :id")
    suspend fun recordDelivery(id: String, delivered: Boolean)

    /**
     * Rows that were handed to the radio and never produced a result. Android
     * does not guarantee a sent broadcast if the process is killed mid-flight,
     * so without this sweep a row would sit in SENDING for ever and the server
     * would never hear an answer.
     */
    @Query("SELECT * FROM queued_message WHERE state = 'SENDING' AND sendStartedAt < :before")
    suspend fun stuckSending(before: Long): List<MessageEntity>

    @Query(
        "SELECT * FROM queued_message WHERE state IN ('SENT', 'FAILED') " +
            "AND receiptAccepted = 0 AND nextReceiptAt <= :now " +
            "ORDER BY sentAt ASC LIMIT :limit",
    )
    suspend fun receiptsDue(now: Long, limit: Int): List<MessageEntity>

    @Query("UPDATE queued_message SET receiptAccepted = 1 WHERE id IN (:ids)")
    suspend fun markReceiptsAccepted(ids: List<String>)

    @Query(
        "UPDATE queued_message SET receiptAttempts = receiptAttempts + 1, " +
            "nextReceiptAt = :nextAt WHERE id IN (:ids)",
    )
    suspend fun deferReceipts(ids: List<String>, nextAt: Long)

    // ------------------------------------------------------------- observers

    @Query("SELECT COUNT(*) FROM queued_message WHERE state IN ('QUEUED', 'SENDING')")
    fun observeQueueDepth(): Flow<Int>

    @Query(
        "SELECT COUNT(*) FROM queued_message WHERE state IN ('SENT', 'FAILED') " +
            "AND receiptAccepted = 0",
    )
    fun observePendingReceipts(): Flow<Int>

    @Query("SELECT COUNT(*) FROM queued_message WHERE state = 'SENT' AND sentAt >= :since")
    fun observeSentSince(since: Long): Flow<Int>

    @Query("SELECT COUNT(*) FROM queued_message WHERE state = 'FAILED' AND sentAt >= :since")
    fun observeFailedSince(since: Long): Flow<Int>

    @Query("SELECT COUNT(*) FROM queued_message WHERE state = 'SENT' AND sentAt >= :since")
    suspend fun countSentSince(since: Long): Int

    @Query(
        "SELECT id, error, sentAt, attempt FROM queued_message WHERE state = 'FAILED' " +
            "AND sentAt >= :since ORDER BY sentAt DESC LIMIT :limit",
    )
    fun observeRecentFailures(since: Long, limit: Int): Flow<List<FailureRow>>

    /**
     * Timestamps of recent successful sends, for the per-minute cap. Kept in the
     * database rather than in memory so a service restart cannot be used — by
     * accident — to reset the carrier's patience.
     */
    @Query("SELECT sentAt FROM queued_message WHERE sentAt >= :since AND state = 'SENT' ORDER BY sentAt")
    suspend fun sendTimestampsSince(since: Long): List<Long>

    /** A week of history is plenty for "what went wrong on Tuesday". */
    @Query("DELETE FROM queued_message WHERE receiptAccepted = 1 AND sentAt < :before")
    suspend fun pruneSettledBefore(before: Long): Int
}

/** Projection for the status screen's failure list. No body, by construction. */
data class FailureRow(
    val id: String,
    val error: String?,
    val sentAt: Long?,
    val attempt: Int,
)
