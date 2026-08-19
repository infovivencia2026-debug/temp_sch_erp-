package com.schoolerp.bustracker.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Distance on the ground, so the app can judge a geofence with no network.
 *
 * Haversine on a spherical earth. Over the few hundred metres a stop's
 * geofence spans, the error against a proper ellipsoid is centimetres —
 * far inside the accuracy of the fix being measured — and it needs no
 * dependency, which matters because this runs offline in a dead zone.
 */
object Geo {

    private const val EARTH_RADIUS_M = 6_371_008.8

    fun metresBetween(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
    }

    /**
     * The fix's own accuracy widens the fence rather than narrowing it. A 60 m
     * fence read by a 40 m fix is not a 60 m fence; refusing to call the
     * arrival until the phone is impossibly certain means a bus that never
     * arrives anywhere on a cloudy morning.
     */
    fun isInside(
        fixLat: Double,
        fixLon: Double,
        accuracyM: Double?,
        stopLat: Double,
        stopLon: Double,
        geofenceM: Int,
    ): Boolean {
        val slack = (accuracyM ?: 0.0).coerceIn(0.0, MAX_ACCURACY_SLACK_M)
        return metresBetween(fixLat, fixLon, stopLat, stopLon) <= geofenceM + slack
    }

    /**
     * Past this the fix is too vague to say anything about a stop. A cell-tower
     * fix with a two-kilometre radius would otherwise "arrive" at every stop on
     * the route at once.
     */
    const val MAX_ACCURACY_SLACK_M = 100.0
}
