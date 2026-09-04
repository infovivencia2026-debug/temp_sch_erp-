package com.schoolerp.bustracker.data.remote

import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.navigation.LatLng
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The driving route through the stops, from an OSRM server.
 *
 * One call: `/route/v1/driving/{lng,lat;...}` with the full geometry and the
 * steps, because the steps are the directions and the geometry is the line
 * under the bus. Nothing else of OSRM's API is used.
 *
 * THE PUBLIC DEMO SERVER IS NOT A SERVICE. `router.project-osrm.org`, the
 * build's default, is the OSRM project's own test instance: no key, no uptime
 * promise, rate-limited per IP, and its usage policy says testing and
 * evaluation only. It is enough to put directions in front of a driver today;
 * a fleet must run its own (see OSRM_BASE_URL in app/build.gradle.kts). Every
 * failure here degrades to straight lines between stops rather than to an
 * empty screen, so an unreachable router costs the driver the road shape and
 * nothing else.
 */
class OsrmApi(
    private val client: HttpClient,
    private val json: Json,
    private val baseUrl: String,
    private val userAgent: String,
) {

    /** Null on any failure: no signal, a 429 from the demo server, a route it cannot find. */
    suspend fun route(through: List<LatLng>): OsrmRoute? {
        if (through.size < 2) return null
        val coordinates = through.joinToString(";") { "${it.longitude},${it.latitude}" }
        val url = "${baseUrl.trimEnd('/')}/route/v1/driving/$coordinates" +
            "?overview=full&geometries=polyline&steps=true"
        return try {
            val response = client.get(url) {
                // The demo server drops anonymous clients first when it is
                // busy; a named one is at least a known quantity.
                header(HttpHeaders.UserAgent, userAgent)
            }
            if (response.status.value != 200) {
                BtLog.w("osrm", "route answered ${response.status.value}")
                return null
            }
            val body = json.decodeFromString<OsrmResponse>(response.bodyAsText())
            if (body.code != "Ok") {
                BtLog.w("osrm", "route refused: ${body.code}")
                return null
            }
            body.routes.firstOrNull()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            BtLog.w("osrm", "route failed", e)
            null
        }
    }
}

@Serializable
data class OsrmResponse(
    val code: String,
    val routes: List<OsrmRoute> = emptyList(),
)

@Serializable
data class OsrmRoute(
    val distance: Double,
    val duration: Double,
    val geometry: String,
    val legs: List<OsrmLeg> = emptyList(),
)

@Serializable
data class OsrmLeg(
    val distance: Double,
    val duration: Double,
    val steps: List<OsrmStep> = emptyList(),
)

@Serializable
data class OsrmStep(
    val distance: Double,
    val duration: Double,
    val geometry: String,
    val name: String = "",
    val maneuver: OsrmManeuver,
)

@Serializable
data class OsrmManeuver(
    val type: String,
    val modifier: String? = null,
    val exit: Int? = null,
    /** `[longitude, latitude]`, in OSRM's order. */
    val location: List<Double> = emptyList(),
)
