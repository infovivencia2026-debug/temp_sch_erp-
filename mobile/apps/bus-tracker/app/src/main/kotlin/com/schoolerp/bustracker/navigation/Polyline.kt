package com.schoolerp.bustracker.navigation

/** A point on the ground, in the order people say it: latitude, then longitude. */
data class LatLng(val latitude: Double, val longitude: Double)

/**
 * Google's encoded-polyline format, which is what OSRM answers with when asked
 * for `geometries=polyline`. Five decimal places, deltas, base-64-ish chunks.
 *
 * Decoded here rather than asking for GeoJSON because a full-overview route
 * across a city is a few thousand points, and the JSON form of that is ten
 * times the bytes over a bus's mobile data for no gain the phone can see.
 */
object Polyline {

    fun decode(encoded: String, precision: Int = 5): List<LatLng> {
        val factor = Math.pow(10.0, precision.toDouble())
        val out = ArrayList<LatLng>(encoded.length / 4)
        var index = 0
        var lat = 0L
        var lng = 0L
        while (index < encoded.length) {
            var result = 0L
            var shift = 0
            var byte: Int
            do {
                byte = encoded[index++].code - 63
                result = result or ((byte and 0x1f).toLong() shl shift)
                shift += 5
            } while (byte >= 0x20 && index < encoded.length)
            lat += if (result and 1L != 0L) (result shr 1).inv() else result shr 1

            result = 0L
            shift = 0
            do {
                byte = encoded[index++].code - 63
                result = result or ((byte and 0x1f).toLong() shl shift)
                shift += 5
            } while (byte >= 0x20 && index < encoded.length)
            lng += if (result and 1L != 0L) (result shr 1).inv() else result shr 1

            out.add(LatLng(lat / factor, lng / factor))
        }
        return out
    }
}
