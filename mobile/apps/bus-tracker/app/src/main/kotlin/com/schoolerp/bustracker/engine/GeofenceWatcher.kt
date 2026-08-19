package com.schoolerp.bustracker.engine

import com.schoolerp.bustracker.core.Geo
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.device.Fix

/**
 * Judges arrivals on the phone, with no network.
 *
 * The stop list arrives with the trip precisely so this can run in a dead zone:
 * the driver gets "Reached Anna Nagar" on the screen at the moment it happens,
 * not twenty minutes later when the tunnel ends.
 *
 * This is not the school's record. The server walks the same geofences when the
 * fixes land, using the same radii — that is why they come down with the trip —
 * and its verdict is the one parents see. Keeping the two apart means a phone
 * with a wandering GPS can mislead its own driver for a second and cannot
 * mislead a parent at all.
 */
class GeofenceWatcher(private val stops: List<StopEntity>) {

    /**
     * Stops newly entered by this fix. A stop already marked arrived is not
     * reported again: a bus idling inside a fence for five minutes would
     * otherwise produce a notification every ping.
     */
    fun arrivalsFor(fix: Fix): List<StopEntity> = stops.filter { stop ->
        stop.arrivedAtMillis == null &&
            stop.latitude != null &&
            stop.longitude != null &&
            stop.geofenceM > 0 &&
            Geo.isInside(
                fixLat = fix.latitude,
                fixLon = fix.longitude,
                accuracyM = fix.accuracyM,
                stopLat = stop.latitude,
                stopLon = stop.longitude,
                geofenceM = stop.geofenceM,
            )
    }
}
