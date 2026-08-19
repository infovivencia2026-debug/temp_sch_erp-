package com.schoolerp.smsgateway

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.schoolerp.smsgateway.data.local.GatewayDatabase
import com.schoolerp.smsgateway.data.local.MessageDao
import com.schoolerp.smsgateway.data.local.MessageEntity
import com.schoolerp.smsgateway.data.local.MessageState
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The one place an instrumented test earns its keep: these guarantees are
 * enforced by SQLite, not by Kotlin, and a fake DAO would prove nothing.
 */
@RunWith(AndroidJUnit4::class)
class MessageDaoTest {

    private lateinit var db: GatewayDatabase
    private lateinit var dao: MessageDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            GatewayDatabase::class.java,
        ).build()
        dao = db.messages()
    }

    @After
    fun tearDown() = db.close()

    private fun row(id: String, state: MessageState = MessageState.QUEUED) = MessageEntity(
        id = id,
        toAddress = "+919812345678",
        bodyRaw = "Fee of Rs 12,500 is due",
        claimedAt = 1_000L,
        state = state,
    )

    @Test
    fun redeliveredIdDoesNotResurrectASentMessage() = runTest {
        dao.insertIgnoringKnown(listOf(row("m1")))
        dao.markSending("m1", parts = 1, now = 2_000L)
        dao.recordPartResult("m1", error = null)
        dao.settle("m1", MessageState.SENT, sentAt = 3_000L, error = null)

        // The server's lease expired before our receipt landed, so it hands the
        // same id back. Sending it again would be a duplicate SMS to a parent.
        val result = dao.insertIgnoringKnown(listOf(row("m1")))

        assertEquals(listOf(-1L), result)
        assertEquals(MessageState.SENT, dao.byId("m1")!!.state)
        assertTrue(dao.nextQueued(10).isEmpty())
    }

    @Test
    fun settlingAMessageErasesItsText() = runTest {
        dao.insertIgnoringKnown(listOf(row("m1")))
        dao.markSending("m1", parts = 1, now = 2_000L)
        dao.settle("m1", MessageState.SENT, sentAt = 3_000L, error = null)

        assertEquals("", dao.byId("m1")!!.bodyRaw)
    }

    @Test
    fun aMultipartMessageSettlesOnlyWhenEveryPartHasReported() = runTest {
        dao.insertIgnoringKnown(listOf(row("m1")))
        dao.markSending("m1", parts = 3, now = 2_000L)

        dao.recordPartResult("m1", error = null)
        assertEquals(2, dao.partsPending("m1"))

        dao.recordPartResult("m1", error = "no_service")
        dao.recordPartResult("m1", error = null)

        assertEquals(0, dao.partsPending("m1"))
        // One failed segment fails the message: half a fee reminder is not a
        // delivered fee reminder.
        assertEquals("no_service", dao.byId("m1")!!.error)
    }

    @Test
    fun onlySettledUnreportedRowsAreDueForAReceipt() = runTest {
        dao.insertIgnoringKnown(listOf(row("queued"), row("sent"), row("reported")))
        dao.settle("sent", MessageState.SENT, sentAt = 3_000L, error = null)
        dao.settle("reported", MessageState.FAILED, sentAt = 3_000L, error = "no_service")
        dao.markReceiptsAccepted(listOf("reported"))

        val due = dao.receiptsDue(now = 9_000L, limit = 10)

        assertEquals(listOf("sent"), due.map { it.id })
    }

    @Test
    fun aDeferredReceiptIsNotRetriedBeforeItsTime() = runTest {
        dao.insertIgnoringKnown(listOf(row("m1")))
        dao.settle("m1", MessageState.SENT, sentAt = 3_000L, error = null)
        dao.deferReceipts(listOf("m1"), nextAt = 10_000L)

        assertTrue(dao.receiptsDue(now = 9_000L, limit = 10).isEmpty())
        assertEquals(1, dao.receiptsDue(now = 11_000L, limit = 10).size)
        assertEquals(1, dao.byId("m1")!!.receiptAttempts)
    }

    @Test
    fun pruningKeepsAnythingTheServerHasNotAcknowledged() = runTest {
        dao.insertIgnoringKnown(listOf(row("old-reported"), row("old-unreported")))
        dao.settle("old-reported", MessageState.SENT, sentAt = 1_000L, error = null)
        dao.settle("old-unreported", MessageState.SENT, sentAt = 1_000L, error = null)
        dao.markReceiptsAccepted(listOf("old-reported"))

        dao.pruneSettledBefore(before = 5_000L)

        assertEquals(null, dao.byId("old-reported"))
        assertTrue(dao.byId("old-unreported") != null)
    }
}
