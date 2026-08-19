package com.schoolerp.smsgateway.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.TypeConverter

/**
 * Where a claimed message is in its life.
 *
 * A row is written as [QUEUED] the moment the server hands it over and before
 * anything is handed to the radio, so a crash between claim and send loses
 * nothing: the row is still here on restart.
 */
enum class MessageState { QUEUED, SENDING, SENT, FAILED }

class MessageStateConverter {
    @TypeConverter
    fun toDb(state: MessageState): String = state.name

    @TypeConverter
    fun fromDb(value: String): MessageState =
        runCatching { MessageState.valueOf(value) }.getOrDefault(MessageState.QUEUED)
}

/**
 * One message claimed from the server's outbox.
 *
 * `id` is the server's id and the primary key. That single fact carries most of
 * the correctness in this app: claiming the same id twice cannot create a
 * second row, so a repeated delivery cannot become a second SMS, and a receipt
 * is trivially idempotent.
 */
@Entity(
    tableName = "queued_message",
    indices = [
        Index(value = ["state"]),
        Index(value = ["receiptAccepted", "nextReceiptAt"]),
        Index(value = ["sentAt"]),
    ],
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val toAddress: String,

    /**
     * The text, held only as long as it takes to send. [clearBody] blanks it as
     * soon as an outcome is known, so a handset seized, lost or handed back to
     * a shop does not carry a month of children's names in its database.
     *
     * Read it through `MessageBody` (see [body]); never interpolate it.
     */
    val bodyRaw: String,

    val attempt: Int = 0,
    val state: MessageState = MessageState.QUEUED,

    /** Multipart segment count, known once the body has been divided. */
    val parts: Int = 0,
    /** Segments still awaiting a sent-result broadcast. */
    val partsPending: Int = 0,

    val error: String? = null,
    val claimedAt: Long,
    val sendStartedAt: Long? = null,
    val sentAt: Long? = null,

    /** True once the server has counted this row's receipt in `accepted`. */
    val receiptAccepted: Boolean = false,
    val receiptAttempts: Int = 0,
    /** Earliest millis at which the receipt may be retried. */
    val nextReceiptAt: Long = 0,

    /**
     * Carrier delivery report, when one arrives. Kept for the status screen
     * only: the contract's receipt vocabulary is `sent|failed`, and delivery
     * reports can arrive minutes later or never, so the receipt is not held
     * back waiting for one.
     */
    val delivered: Boolean? = null,
) {
    /**
     * Redacted on purpose. A `data class` toString is how message bodies end up
     * in crash reports.
     */
    override fun toString(): String =
        "MessageEntity(id=$id, state=$state, attempt=$attempt, parts=$parts, " +
            "partsPending=$partsPending, error=$error, sentAt=$sentAt, " +
            "receiptAccepted=$receiptAccepted, bodyLength=${bodyRaw.length})"
}
