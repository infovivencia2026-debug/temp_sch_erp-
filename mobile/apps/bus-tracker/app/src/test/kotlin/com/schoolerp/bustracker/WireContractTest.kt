package com.schoolerp.bustracker

import com.schoolerp.bustracker.data.remote.BoardingMark
import com.schoolerp.bustracker.data.remote.BoardingRequest
import com.schoolerp.bustracker.data.remote.ClaimRequest
import com.schoolerp.bustracker.data.remote.ClaimResponse
import com.schoolerp.bustracker.data.remote.EndTripRequest
import com.schoolerp.bustracker.data.remote.HeartbeatRequest
import com.schoolerp.bustracker.data.remote.HeartbeatResponse
import com.schoolerp.bustracker.data.remote.PositionFix
import com.schoolerp.bustracker.data.remote.PositionsRequest
import com.schoolerp.bustracker.data.remote.PositionsResponse
import com.schoolerp.bustracker.data.remote.RosterResponse
import com.schoolerp.bustracker.data.remote.StartTripRequest
import com.schoolerp.bustracker.data.remote.StartTripResponse
import com.schoolerp.bustracker.data.remote.TrackerApi
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The test that exists because of the SMS gateway.
 *
 * That contract left the rate-cap field unnamed, the two halves of the system
 * arrived at `per_minute_cap` and `max_per_minute` independently, and nothing
 * failed, logged, or noticed. Here every field name in
 * docs/BUS_TRACKER_CONTRACT.md is asserted against the JSON this app actually
 * emits and parses, so the same drift is a red test rather than a bus quietly
 * missing from the map.
 */
class WireContractTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    @Test
    fun `claim request carries the field names the contract lists`() {
        val encoded = json.encodeToString(
            ClaimRequest(
                pairCode = "ABCD2345",
                deviceName = "Redmi Note 12",
                deviceModel = "23021RAAEG",
                androidVersion = "Android 14 (API 34)",
                appVersion = "1.0.0",
            ),
        )
        listOf("pair_code", "device_name", "device_model", "android_version", "app_version")
            .forEach { assertTrue("$it missing from $encoded", encoded.contains("\"$it\"")) }
    }

    @Test
    fun `claim response yields the vehicle registration the driver is shown`() {
        val decoded = json.decodeFromString<ClaimResponse>(
            """
            {"device_id":"d1","device_token":"secret","institution":"11111111-1111-1111-1111-111111111111",
             "vehicle":{"id":"v1","registration_no":"TN 09 AB 1234"},"ping_seconds":20}
            """.trimIndent(),
        )
        assertEquals("TN 09 AB 1234", decoded.vehicle.registrationNo)
        assertEquals(20, decoded.pingSeconds)
    }

    @Test
    fun `claim response also accepts institution as an object`() {
        // The contract names the field but not its shape, and the server today
        // sends a bare uuid. Both readings have to work or pairing fails on a
        // field mismatch the driver cannot do anything about.
        val decoded = json.decodeFromString<ClaimResponse>(
            """
            {"device_id":"d1","device_token":"s","institution":{"id":"i1","name":"St Mary's"},
             "vehicle":{"registration_no":"KA 01 X 9"}}
            """.trimIndent(),
        )
        assertEquals("St Mary's", decoded.institution?.name)
    }

    @Test
    fun `the token never appears in a claim response toString`() {
        val response = ClaimResponse(
            deviceId = "d1",
            deviceToken = "super-secret-token",
            institution = null,
            vehicle = com.schoolerp.bustracker.data.remote.Vehicle(id = null, registrationNo = "TN 1"),
        )
        assertTrue(!response.toString().contains("super-secret-token"))
    }

    @Test
    fun `start trip request names route_id direction and started_at`() {
        val encoded = json.encodeToString(
            StartTripRequest(routeId = "r1", direction = "pickup", startedAt = "2026-08-19T06:40:00+05:30"),
        )
        assertTrue(encoded.contains("\"route_id\""))
        assertTrue(encoded.contains("\"direction\":\"pickup\""))
        assertTrue(encoded.contains("\"started_at\""))
    }

    @Test
    fun `start trip response carries geofence radii so arrivals work offline`() {
        val decoded = json.decodeFromString<StartTripResponse>(
            """
            {"trip_id":"t1","stops":[
              {"id":"s1","name":"Anna Nagar","sequence":1,"latitude":13.08,"longitude":80.21,
               "geofence_m":80,"scheduled_at":"2026-08-19T07:00:00+05:30"}]}
            """.trimIndent(),
        )
        assertEquals("t1", decoded.tripId)
        assertEquals(80, decoded.stops.single().geofenceM)
    }

    @Test
    fun `end trip reports reason driver`() {
        val encoded = json.encodeToString(EndTripRequest(endedAt = "2026-08-19T08:10:00+05:30"))
        assertTrue(encoded.contains("\"ended_at\""))
        assertTrue(encoded.contains("\"reason\":\"driver\""))
    }

    @Test
    fun `position fix uses the contract's names and omits what it does not know`() {
        val encoded = json.encodeToString(
            PositionsRequest(
                tripId = "t1",
                fixes = listOf(
                    PositionFix(
                        recordedAt = "2026-08-19T14:32:05+05:30",
                        latitude = 13.08,
                        longitude = 80.21,
                        speedKmph = 32.5,
                        headingDeg = 91,
                        accuracyM = 8.0,
                    ),
                ),
            ),
        )
        listOf("trip_id", "fixes", "recorded_at", "latitude", "longitude", "speed_kmph", "heading_deg", "accuracy_m")
            .forEach { assertTrue("$it missing from $encoded", encoded.contains("\"$it\"")) }
    }

    @Test
    fun `positions response reads accepted as a list of times not a count`() {
        val decoded = json.decodeFromString<PositionsResponse>(
            """
            {"accepted":["2026-08-19T09:02:05Z","2026-08-19T09:02:25Z"],
             "ping_seconds":30,"paused":false,"trip_open":true}
            """.trimIndent(),
        )
        assertEquals(2, decoded.accepted.size)
        assertEquals(30, decoded.pingSeconds)
        assertTrue(decoded.tripOpen)
    }

    @Test
    fun `a positions response with no trip_open defaults to open`() {
        // Defaulting the other way would have a phone stop reporting because a
        // field was absent, which is a silent end to a run in progress.
        val decoded = json.decodeFromString<PositionsResponse>("""{"accepted":[]}""")
        assertTrue(decoded.tripOpen)
    }

    @Test
    fun `heartbeat names battery_pct charging location_ok and app_version`() {
        val encoded = json.encodeToString(
            HeartbeatRequest(batteryPct = 62, charging = true, locationOk = false, appVersion = "1.0.0"),
        )
        listOf("battery_pct", "charging", "location_ok", "app_version")
            .forEach { assertTrue("$it missing from $encoded", encoded.contains("\"$it\"")) }
        assertTrue(encoded.contains("\"location_ok\":false"))
    }

    @Test
    fun `heartbeat response directives are optional and paused defaults false`() {
        val decoded = json.decodeFromString<HeartbeatResponse>("{}")
        assertNull(decoded.pingSeconds)
        assertEquals(false, decoded.paused)
    }

    @Test
    fun `paths are exactly the ones the contract lists`() {
        assertEquals("/api/v1/public/bus-tracker/claim", TrackerApi.PATH_CLAIM)
        assertEquals("/api/v1/bus-tracker/trips", TrackerApi.PATH_TRIPS)
        assertEquals("/api/v1/bus-tracker/trips/t1/end", TrackerApi.pathEndTrip("t1"))
        assertEquals("/api/v1/bus-tracker/positions", TrackerApi.PATH_POSITIONS)
        assertEquals("/api/v1/bus-tracker/heartbeat", TrackerApi.PATH_HEARTBEAT)
        assertEquals(200, TrackerApi.MAX_FIXES_PER_PUSH)
    }

    /* THE ROSTER, THE TAPS AND THE OFFICE'S MESSAGES.
     *
     * The same discipline for the three shapes the roster feature added: every
     * documented key is read from JSON the server would actually send, and the
     * driver's marks are encoded under the names the server reads.
     */

    @Test
    fun `roster response decodes every documented student field`() {
        val decoded = json.decodeFromString<RosterResponse>(
            """
            {"trip_id":"t1","direction":"pickup","leg":"morning","students":[
              {"id":"s1","name":"Anita","admission_no":"A-17","class":"3 B","stop_id":"st1",
               "has_photo":true,"absent":true,"absent_reason":"fever","status":"absent",
               "marked_at":"2026-09-03T07:10:00Z"}]}
            """.trimIndent(),
        )
        assertEquals("t1", decoded.tripId)
        assertEquals("pickup", decoded.direction)
        assertEquals("morning", decoded.leg)
        val child = decoded.students.single()
        assertEquals("s1", child.id)
        assertEquals("Anita", child.name)
        assertEquals("A-17", child.admissionNo)
        assertEquals("3 B", child.className)
        assertEquals("st1", child.stopId)
        assertEquals(true, child.hasPhoto)
        assertEquals(true, child.absent)
        assertEquals("fever", child.absentReason)
        assertEquals("absent", child.status)
        assertEquals("2026-09-03T07:10:00Z", child.markedAt)
    }

    @Test
    fun `roster student fields beyond id and name are optional`() {
        val decoded = json.decodeFromString<RosterResponse>(
            """{"trip_id":"t1","students":[{"id":"s1","name":"Anita"}]}""",
        )
        val child = decoded.students.single()
        assertEquals("", child.stopId)
        assertEquals(false, child.hasPhoto)
        assertEquals(false, child.absent)
        assertEquals("", child.status)
    }

    @Test
    fun `boarding request names marks student_id status and at`() {
        val encoded = json.encodeToString(
            BoardingRequest(listOf(BoardingMark(studentId = "s1", status = "boarded", at = "2026-09-03T07:10:00Z"))),
        )
        assertTrue(encoded, encoded.contains("\"marks\""))
        listOf("student_id", "status", "at")
            .forEach { assertTrue("$it missing from $encoded", encoded.contains("\"$it\"")) }
    }

    @Test
    fun `heartbeat response carries notices with id body and sent_at`() {
        val decoded = json.decodeFromString<HeartbeatResponse>(
            """{"notices":[{"id":"n1","body":"Wait at the gate","sent_at":"2026-09-03T07:00:00Z"}]}""",
        )
        val notice = decoded.notices.single()
        assertEquals("n1", notice.id)
        assertEquals("Wait at the gate", notice.body)
        assertEquals("2026-09-03T07:00:00Z", notice.sentAt)
    }

    @Test
    fun `heartbeat response without notices means none, not a parse error`() {
        assertTrue(json.decodeFromString<HeartbeatResponse>("{}").notices.isEmpty())
    }

    @Test
    fun `roster boarding photo and ack paths are exactly the ones the contract lists`() {
        assertEquals("/api/v1/bus-tracker/trips/t1/roster", TrackerApi.pathRoster("t1"))
        assertEquals("/api/v1/bus-tracker/trips/t1/boarding", TrackerApi.pathBoarding("t1"))
        assertEquals("/api/v1/bus-tracker/students/s1/photo", TrackerApi.pathStudentPhoto("s1"))
        assertEquals("/api/v1/bus-tracker/notices/n1/ack", TrackerApi.pathAckNotice("n1"))
    }
}
