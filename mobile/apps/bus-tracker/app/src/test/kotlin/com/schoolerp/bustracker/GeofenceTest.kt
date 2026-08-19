package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.Geo
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.device.Fix
import com.schoolerp.bustracker.engine.GeofenceWatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeofenceTest {

    private fun stop(
        id: String,
        lat: Double?,
        lon: Double?,
        geofence: Int = 80,
        arrivedAt: Long? = null,
    ) = StopEntity(
        tripId = "t1",
        stopId = id,
        name = "Stop $id",
        sequence = 1,
        latitude = lat,
        longitude = lon,
        geofenceM = geofence,
        scheduledAt = null,
        arrivedAtMillis = arrivedAt,
    )

    private fun fix(lat: Double, lon: Double, accuracy: Double? = 5.0) =
        Fix(atMillis = 0L, latitude = lat, longitude = lon, speedKmph = null, headingDeg = null, accuracyM = accuracy)

    @Test
    fun `haversine agrees with a known short distance`() {
        // One thousandth of a degree of latitude is about 111 m anywhere.
        val metres = Geo.metresBetween(13.0000, 80.0000, 13.0010, 80.0000)
        assertTrue("got $metres", metres in 110.0..112.0)
    }

    @Test
    fun `a bus inside the fence has arrived`() {
        val watcher = GeofenceWatcher(listOf(stop("s1", 13.0000, 80.0000, geofence = 120)))
        assertEquals(1, watcher.arrivalsFor(fix(13.0005, 80.0000)).size)
    }

    @Test
    fun `a bus a street away has not`() {
        val watcher = GeofenceWatcher(listOf(stop("s1", 13.0000, 80.0000, geofence = 60)))
        assertTrue(watcher.arrivalsFor(fix(13.0050, 80.0000)).isEmpty())
    }

    @Test
    fun `a vague fix widens the fence rather than narrowing it`() {
        // Refusing the arrival until the phone is impossibly certain means a bus
        // that never arrives anywhere on a cloudy morning.
        val watcher = GeofenceWatcher(listOf(stop("s1", 13.0000, 80.0000, geofence = 50)))
        assertTrue(watcher.arrivalsFor(fix(13.0006, 80.0000, accuracy = 3.0)).isEmpty())
        assertEquals(1, watcher.arrivalsFor(fix(13.0006, 80.0000, accuracy = 40.0)).size)
    }

    @Test
    fun `a cell-tower fix does not arrive at every stop on the route at once`() {
        val stops = listOf(
            stop("s1", 13.0000, 80.0000, geofence = 60),
            stop("s2", 13.0100, 80.0000, geofence = 60),
        )
        // 2 km of claimed accuracy is capped, so it cannot swallow the route.
        val arrivals = GeofenceWatcher(stops).arrivalsFor(fix(13.0050, 80.0000, accuracy = 2000.0))
        assertTrue(arrivals.isEmpty())
    }

    @Test
    fun `a stop already reached is not reported again`() {
        // A bus idling inside a fence for five minutes would otherwise notify
        // the driver on every ping.
        val watcher = GeofenceWatcher(listOf(stop("s1", 13.0000, 80.0000, arrivedAt = 1L)))
        assertTrue(watcher.arrivalsFor(fix(13.0000, 80.0000)).isEmpty())
    }

    @Test
    fun `a stop with no coordinates is skipped rather than crashing the run`() {
        val watcher = GeofenceWatcher(listOf(stop("s1", null, null)))
        assertTrue(watcher.arrivalsFor(fix(13.0, 80.0)).isEmpty())
    }

    @Test
    fun `a zero radius means the office has not set a fence, not a fence at the exact point`() {
        val watcher = GeofenceWatcher(listOf(stop("s1", 13.0, 80.0, geofence = 0)))
        assertTrue(watcher.arrivalsFor(fix(13.0, 80.0)).isEmpty())
    }
}
