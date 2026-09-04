package com.schoolerp.bustracker.navigation

import com.schoolerp.bustracker.core.Geo
import com.schoolerp.bustracker.data.remote.OsrmRoute
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A route through the remaining stops, flattened to the two things the screen
 * needs: one line to draw and one list of manoeuvres along it.
 *
 * Built from OSRM's steps rather than its overview geometry, because a step's
 * geometry starts exactly at its manoeuvre, so concatenating the steps gives
 * a line in which every manoeuvre is a known index. That is what lets the
 * navigator work by projection alone: find the bus on the line, and the next
 * manoeuvre is the first one further along it. No "advance the step" state
 * to get wrong when the GPS jumps.
 */
class RoutePlan(
    val line: List<LatLng>,
    val steps: List<Step>,
    val legs: List<Leg>,
    /** True when the line follows roads; false when it is the straight-line fallback. */
    val roadFollowing: Boolean,
) {
    /** Metres from the start of the line to each vertex. */
    val cumulative: DoubleArray = DoubleArray(line.size).also { acc ->
        for (i in 1 until line.size) {
            acc[i] = acc[i - 1] + Geo.metresBetween(
                line[i - 1].latitude, line[i - 1].longitude, line[i].latitude, line[i].longitude,
            )
        }
    }

    data class Step(
        val legIndex: Int,
        /** Index into [line] of the manoeuvre point. */
        val index: Int,
        val type: String,
        val modifier: String?,
        val exit: Int?,
        val roadName: String,
    )

    data class Leg(
        /** Index into [line] where this leg ends: the stop. */
        val endIndex: Int,
        val distanceM: Double,
        val durationS: Double,
    )

    companion object {
        fun fromOsrm(route: OsrmRoute): RoutePlan? {
            val line = ArrayList<LatLng>()
            val steps = ArrayList<Step>()
            val legs = ArrayList<Leg>()
            route.legs.forEachIndexed { legIndex, leg ->
                leg.steps.forEach { step ->
                    val points = Polyline.decode(step.geometry)
                    if (points.isEmpty()) return@forEach
                    // Consecutive steps share their joining vertex; keep one.
                    val start = if (line.isNotEmpty() && line.last() == points.first()) 1 else 0
                    val index = if (start == 1) line.size - 1 else line.size
                    steps += Step(
                        legIndex = legIndex,
                        index = index,
                        type = step.maneuver.type,
                        modifier = step.maneuver.modifier,
                        exit = step.maneuver.exit,
                        roadName = step.name,
                    )
                    for (i in start until points.size) line += points[i]
                }
                legs += Leg(endIndex = (line.size - 1).coerceAtLeast(0), distanceM = leg.distance, durationS = leg.duration)
            }
            if (line.size < 2) return null
            return RoutePlan(line, steps, legs, roadFollowing = true)
        }

        /**
         * Straight lines between the points, for when there is no router.
         * One "arrive" per stop so the banner still counts down to it.
         */
        fun straight(through: List<LatLng>): RoutePlan? {
            if (through.size < 2) return null
            val steps = ArrayList<Step>()
            val legs = ArrayList<Leg>()
            for (i in 1 until through.size) {
                val metres = Geo.metresBetween(
                    through[i - 1].latitude, through[i - 1].longitude, through[i].latitude, through[i].longitude,
                )
                steps += Step(legIndex = i - 1, index = i, type = "arrive", modifier = null, exit = null, roadName = "")
                // A guess at town speed, so the ETA is a number and not a blank.
                legs += Leg(endIndex = i, distanceM = metres, durationS = metres / ASSUMED_MPS)
            }
            return RoutePlan(through, steps, legs, roadFollowing = false)
        }

        private const val ASSUMED_MPS = 25_000.0 / 3600
    }
}

/** What the driver is told, right now. */
data class Guidance(
    val line: List<LatLng>,
    val roadFollowing: Boolean,
    /** The bus, when there has been a fix this run. */
    val bus: LatLng?,
    /** Degrees clockwise from north, for pointing the map the way the bus is going. */
    val headingDeg: Double?,
    val maneuver: Maneuver?,
    val nextStopName: String,
    val nextStopDistanceM: Double?,
    val etaSeconds: Double?,
    /** Within [Navigator.ARRIVE_M] of the next stop. */
    val arriving: Boolean,
    /** Further than [Navigator.OFF_ROUTE_M] from the line: the plan wants refreshing. */
    val offRoute: Boolean,
    /** Something to say aloud, once. Keyed so the caller can dedupe. */
    val cue: Cue?,
)

data class Maneuver(
    val type: String,
    val modifier: String?,
    val exit: Int?,
    val roadName: String,
    val distanceM: Double,
) {
    /** Clockwise degrees from straight ahead, for drawing one arrow rotated. */
    val arrowDegrees: Float
        get() = when (modifier) {
            "uturn" -> 180f
            "sharp right" -> 135f
            "right" -> 90f
            "slight right" -> 45f
            "slight left" -> -45f
            "left" -> -90f
            "sharp left" -> -135f
            else -> 0f
        }

    /** "Turn left onto Suchitra Road", in the words a passenger would use. */
    val instruction: String
        get() {
            val onto = if (roadName.isBlank()) "" else " onto $roadName"
            val side = when (modifier) {
                "sharp right" -> "sharp right"
                "slight right" -> "slight right"
                "sharp left" -> "sharp left"
                "slight left" -> "slight left"
                else -> modifier
            }
            return when (type) {
                "turn", "end of road" -> when (modifier) {
                    "straight" -> "Continue straight$onto"
                    "uturn" -> "Make a U-turn$onto"
                    null -> "Turn$onto"
                    else -> "Turn $side$onto"
                }
                "new name", "continue" -> if (roadName.isBlank()) "Continue" else "Continue onto $roadName"
                "depart" -> "Head out$onto"
                "arrive" -> "Arrive at the stop"
                "merge" -> "Merge${side?.let { " $it" } ?: ""}$onto"
                "on ramp" -> "Take the ramp$onto"
                "off ramp" -> "Take the exit$onto"
                "fork" -> "Keep ${side ?: "ahead"}$onto"
                "roundabout", "rotary", "roundabout turn" ->
                    "At the roundabout, take ${exit?.let { ordinal(it) + " exit" } ?: "the exit"}$onto"
                "exit roundabout", "exit rotary" -> "Leave the roundabout$onto"
                else -> if (side != null) "Turn $side$onto" else "Continue$onto"
            }
        }

    private fun ordinal(n: Int): String = when (n) {
        1 -> "the first"
        2 -> "the second"
        3 -> "the third"
        else -> "exit $n"
    }
}

/** One spoken sentence, identified by which manoeuvre and which distance band it belongs to. */
data class Cue(val stepIndex: Int, val band: Int, val text: String)

/**
 * Where the bus is on the plan and what comes next.
 *
 * Stateless on purpose: every fix is projected onto the line afresh, so a
 * phone that missed ten fixes in a tunnel comes out with the right manoeuvre
 * on screen rather than one ten turns stale.
 */
object Navigator {

    /** "Arriving" once inside this many metres of the stop. */
    const val ARRIVE_M = 40.0

    /** Off the line by more than this and the route is asked for again. */
    const val OFF_ROUTE_M = 150.0

    /** A manoeuvre this close is behind us for guidance purposes; show the one after. */
    const val PASSED_M = 25.0

    /** Spoken first here, and again close in. */
    const val CUE_FAR_M = 300.0
    const val CUE_NEAR_M = 50.0

    fun guide(
        plan: RoutePlan,
        bus: LatLng?,
        fixHeadingDeg: Double?,
        previousBus: LatLng?,
        nextStopName: String,
        nextStop: LatLng?,
    ): Guidance {
        if (bus == null) {
            return Guidance(
                line = plan.line, roadFollowing = plan.roadFollowing, bus = null, headingDeg = null,
                maneuver = null, nextStopName = nextStopName, nextStopDistanceM = null,
                etaSeconds = null, arriving = false, offRoute = false, cue = null,
            )
        }

        val projection = project(plan, bus)
        val along = projection.alongM
        val offRoute = projection.offM > OFF_ROUTE_M

        // The leg the bus is on is the first whose end is still ahead.
        val legIndex = plan.legs.indexOfFirst { plan.cumulative[it.endIndex] > along }.let {
            if (it < 0) plan.legs.lastIndex else it
        }
        val leg = plan.legs.getOrNull(legIndex)

        val stepIndex = plan.steps.indexOfFirst { step ->
            step.type != "depart" && plan.cumulative[step.index] - along > PASSED_M
        }
        val step = plan.steps.getOrNull(stepIndex)
        val maneuver = step?.let {
            Maneuver(
                type = it.type, modifier = it.modifier, exit = it.exit, roadName = it.roadName,
                distanceM = plan.cumulative[it.index] - along,
            )
        }

        val stopDistanceAlong = leg?.let { plan.cumulative[it.endIndex] - along }
        val stopDistanceDirect = nextStop?.let {
            Geo.metresBetween(bus.latitude, bus.longitude, it.latitude, it.longitude)
        }
        // Off the line the along-route number is fiction; the straight one is not.
        val stopDistance = if (offRoute) stopDistanceDirect ?: stopDistanceAlong else stopDistanceAlong ?: stopDistanceDirect
        val eta = leg?.takeIf { it.distanceM > 0 && stopDistance != null }?.let {
            it.durationS * (stopDistance!! / it.distanceM).coerceIn(0.0, 1.0)
        }
        val arriving = (stopDistanceDirect ?: Double.MAX_VALUE) <= ARRIVE_M

        val heading = fixHeadingDeg
            ?: previousBus?.takeIf {
                Geo.metresBetween(it.latitude, it.longitude, bus.latitude, bus.longitude) > 5.0
            }?.let { bearing(it, bus) }
            // Stationary at the depot: face the way the road goes.
            ?: routeBearing(plan, projection.segment)

        val cue = when {
            arriving -> Cue(Int.MAX_VALUE, 0, "Arriving at $nextStopName")
            maneuver == null || step == null || step.type == "arrive" -> null
            maneuver.distanceM <= CUE_NEAR_M -> Cue(stepIndex, 1, maneuver.instruction)
            maneuver.distanceM <= CUE_FAR_M ->
                Cue(stepIndex, 0, "In ${roundMetres(maneuver.distanceM)} metres, ${maneuver.instruction.replaceFirstChar { it.lowercase() }}")
            else -> null
        }

        return Guidance(
            line = plan.line,
            roadFollowing = plan.roadFollowing,
            bus = bus,
            headingDeg = heading,
            maneuver = maneuver,
            nextStopName = nextStopName,
            nextStopDistanceM = stopDistance,
            etaSeconds = eta,
            arriving = arriving,
            offRoute = offRoute,
            cue = cue,
        )
    }

    /** Distances a driver can hear: nothing finer than 50 m, nothing like "in 287 metres". */
    fun roundMetres(metres: Double): Int = ((metres / 50).roundToInt() * 50).coerceAtLeast(50)

    /** "200 m" or "1.4 km", the way a road sign says it. */
    fun humanDistance(metres: Double): String = when {
        metres >= 10_000 -> "${(metres / 1000).roundToInt()} km"
        metres >= 1000 -> "${(metres / 100).roundToInt() / 10.0} km"
        metres >= 100 -> "${(metres / 10).roundToInt() * 10} m"
        else -> "${(metres / 5).roundToInt() * 5} m"
    }

    data class Projection(val segment: Int, val alongM: Double, val offM: Double)

    /**
     * The nearest point on the line to the bus, in a flat local frame. Over
     * the length of one road segment the flat-earth error is nothing, and it
     * keeps this cheap enough to run on every fix against a few thousand
     * vertices.
     */
    fun project(plan: RoutePlan, bus: LatLng): Projection {
        val line = plan.line
        val kLat = 111_320.0
        val kLon = 111_320.0 * cos(Math.toRadians(bus.latitude))
        var bestSeg = 0
        var bestT = 0.0
        var bestDist = Double.MAX_VALUE
        for (i in 0 until line.size - 1) {
            val ax = (line[i].longitude - bus.longitude) * kLon
            val ay = (line[i].latitude - bus.latitude) * kLat
            val bx = (line[i + 1].longitude - bus.longitude) * kLon
            val by = (line[i + 1].latitude - bus.latitude) * kLat
            val dx = bx - ax
            val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = if (len2 == 0.0) 0.0 else (-(ax * dx + ay * dy) / len2).coerceIn(0.0, 1.0)
            val px = ax + t * dx
            val py = ay + t * dy
            val d = sqrt(px * px + py * py)
            if (d < bestDist) {
                bestDist = d
                bestSeg = i
                bestT = t
            }
        }
        val segLen = plan.cumulative[bestSeg + 1] - plan.cumulative[bestSeg]
        return Projection(bestSeg, plan.cumulative[bestSeg] + bestT * segLen, bestDist)
    }

    private fun routeBearing(plan: RoutePlan, segment: Int): Double? {
        val a = plan.line.getOrNull(segment) ?: return null
        val b = plan.line.getOrNull(segment + 1) ?: return null
        return bearing(a, b)
    }

    fun bearing(from: LatLng, to: LatLng): Double {
        val lat1 = Math.toRadians(from.latitude)
        val lat2 = Math.toRadians(to.latitude)
        val dLon = Math.toRadians(to.longitude - from.longitude)
        val y = sin(dLon) * cos(lat2)
        val x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }
}
