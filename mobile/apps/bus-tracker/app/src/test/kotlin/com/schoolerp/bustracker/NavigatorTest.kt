package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.remote.OsrmLeg
import com.schoolerp.bustracker.data.remote.OsrmManeuver
import com.schoolerp.bustracker.data.remote.OsrmRoute
import com.schoolerp.bustracker.data.remote.OsrmStep
import com.schoolerp.bustracker.navigation.LatLng
import com.schoolerp.bustracker.navigation.Navigator
import com.schoolerp.bustracker.navigation.Polyline
import com.schoolerp.bustracker.navigation.RoutePlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigatorTest {

    /* Google's own worked example for the encoding. If this decodes, the
       shifts and the sign bit are right, and OSRM's geometry will too. */
    @Test
    fun `decodes the reference polyline`() {
        val points = Polyline.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        assertEquals(3, points.size)
        assertEquals(38.5, points[0].latitude, 1e-6)
        assertEquals(-120.2, points[0].longitude, 1e-6)
        assertEquals(43.252, points[2].latitude, 1e-6)
        assertEquals(-126.453, points[2].longitude, 1e-6)
    }

    /* A road running due north for a kilometre, with a right turn a third of
       the way along and the stop at the end. The bus is 100 m in. */
    private fun plan(): RoutePlan {
        val a = LatLng(17.5000, 78.5000)
        val turn = LatLng(17.5030, 78.5000)
        val end = LatLng(17.5030, 78.5060)
        fun enc(vararg p: LatLng) = encode(p.toList())
        val route = OsrmRoute(
            distance = 1000.0, duration = 120.0, geometry = enc(a, turn, end),
            legs = listOf(
                OsrmLeg(
                    distance = 1000.0, duration = 120.0,
                    steps = listOf(
                        OsrmStep(333.0, 40.0, enc(a, turn), "Kompally Road", OsrmManeuver("depart", null, null, listOf(a.longitude, a.latitude))),
                        OsrmStep(640.0, 80.0, enc(turn, end), "Suchitra Road", OsrmManeuver("turn", "right", null, listOf(turn.longitude, turn.latitude))),
                        OsrmStep(0.0, 0.0, enc(end), "", OsrmManeuver("arrive", null, null, listOf(end.longitude, end.latitude))),
                    ),
                ),
            ),
        )
        return RoutePlan.fromOsrm(route)!!
    }

    @Test
    fun `the next manoeuvre is the turn ahead, with its road and distance`() {
        val g = Navigator.guide(plan(), LatLng(17.5009, 78.5000), null, null, "School", LatLng(17.5030, 78.5060))
        val m = g.maneuver!!
        assertEquals("turn", m.type)
        assertEquals("Suchitra Road", m.roadName)
        assertEquals(90f, m.arrowDegrees)
        // 333 m of road with 100 m of it behind the bus.
        assertEquals(233.0, m.distanceM, 15.0)
        assertEquals("Turn right onto Suchitra Road", m.instruction)
        assertFalse(g.offRoute)
        assertFalse(g.arriving)
        // Heading up the road, worked out from the road because the fix had none.
        assertEquals(0.0, g.headingDeg!!, 2.0)
        assertNotNull(g.etaSeconds)
    }

    @Test
    fun `within the far band the cue says the distance, within the near band it does not`() {
        val far = Navigator.guide(plan(), LatLng(17.5009, 78.5000), null, null, "School", null)
        assertEquals("In 250 metres, turn right onto Suchitra Road", far.cue!!.text)
        val near = Navigator.guide(plan(), LatLng(17.5027, 78.5000), null, null, "School", null)
        assertEquals("Turn right onto Suchitra Road", near.cue!!.text)
        assertTrue(far.cue!!.band != near.cue!!.band)
    }

    @Test
    fun `a manoeuvre the bus is on top of is behind it`() {
        val g = Navigator.guide(plan(), LatLng(17.50299, 78.5001), null, null, "School", null)
        assertEquals("arrive", g.maneuver!!.type)
    }

    @Test
    fun `off the line by more than the limit asks for a new plan`() {
        val g = Navigator.guide(plan(), LatLng(17.5010, 78.5030), null, null, "School", null)
        assertTrue(g.offRoute)
    }

    @Test
    fun `arriving inside forty metres of the stop`() {
        val stop = LatLng(17.5030, 78.5060)
        val g = Navigator.guide(plan(), LatLng(17.5030, 78.5058), null, null, "School", stop)
        assertTrue(g.arriving)
        assertEquals("Arriving at School", g.cue!!.text)
    }

    @Test
    fun `no fix means no guidance but still a line to draw`() {
        val g = Navigator.guide(plan(), null, null, null, "School", null)
        assertNull(g.maneuver)
        assertEquals(3, g.line.size)
    }

    @Test
    fun `distances read like road signs`() {
        assertEquals("1.2 km", Navigator.humanDistance(1234.0))
        assertEquals("230 m", Navigator.humanDistance(233.0))
        assertEquals("45 m", Navigator.humanDistance(44.0))
    }

    private fun encode(points: List<LatLng>): String {
        val sb = StringBuilder()
        var lastLat = 0L
        var lastLng = 0L
        for (p in points) {
            val lat = Math.round(p.latitude * 1e5)
            val lng = Math.round(p.longitude * 1e5)
            encodeValue(lat - lastLat, sb)
            encodeValue(lng - lastLng, sb)
            lastLat = lat
            lastLng = lng
        }
        return sb.toString()
    }

    private fun encodeValue(value: Long, sb: StringBuilder) {
        var v = if (value < 0) (value shl 1).inv() else value shl 1
        while (v >= 0x20) {
            sb.append(((0x20 or (v and 0x1f).toInt()) + 63).toChar())
            v = v shr 5
        }
        sb.append((v.toInt() + 63).toChar())
    }
}
