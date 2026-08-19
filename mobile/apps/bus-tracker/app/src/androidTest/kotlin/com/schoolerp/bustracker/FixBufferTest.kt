package com.schoolerp.bustracker

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.schoolerp.bustracker.data.local.FixDao
import com.schoolerp.bustracker.data.local.FixEntity
import com.schoolerp.bustracker.data.local.TrackerDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The buffer is the promise that a dead zone costs nothing. These need a real
 * SQLite, so they are instrumented tests and do not run on a build machine with
 * no device attached.
 */
@RunWith(AndroidJUnit4::class)
class FixBufferTest {

    private lateinit var db: TrackerDatabase
    private lateinit var dao: FixDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            TrackerDatabase::class.java,
        ).build()
        dao = db.fixes()
    }

    @After
    fun tearDown() = db.close()

    private fun fix(trip: String, second: Long) = FixEntity(
        tripId = trip,
        recordedAtSeconds = second,
        recordedAt = "2026-08-19T00:00:${second % 60}+05:30",
        latitude = 13.0,
        longitude = 80.0,
        speedKmph = null,
        headingDeg = null,
        accuracyM = null,
    )

    @Test
    fun `a second fix in the same second does not create a second row`() = runTest {
        dao.insert(fix("t1", 100))
        dao.insert(fix("t1", 100))
        assertEquals(1, dao.countFor("t1"))
    }

    @Test
    fun `the batch comes out oldest first, so the dead zone uploads first`() = runTest {
        listOf(300L, 100L, 200L).forEach { dao.insert(fix("t1", it)) }
        assertEquals(listOf(100L, 200L, 300L), dao.nextBatch("t1", 10).map { it.recordedAtSeconds })
    }

    @Test
    fun `only acknowledged fixes are deleted`() = runTest {
        listOf(100L, 200L, 300L).forEach { dao.insert(fix("t1", it)) }
        dao.deleteAcknowledged("t1", listOf(100L, 300L))
        assertEquals(listOf(200L), dao.nextBatch("t1", 10).map { it.recordedAtSeconds })
    }

    @Test
    fun `one run's buffer is not touched by another's acknowledgement`() = runTest {
        dao.insert(fix("t1", 100))
        dao.insert(fix("t2", 100))
        dao.deleteAcknowledged("t1", listOf(100L))
        assertEquals(0, dao.countFor("t1"))
        assertEquals(1, dao.countFor("t2"))
    }

    @Test
    fun `the batch is capped at what the caller asks for`() = runTest {
        (1L..250L).forEach { dao.insert(fix("t1", it)) }
        assertEquals(200, dao.nextBatch("t1", 200).size)
    }
}
