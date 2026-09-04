package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.core.Geo
import com.schoolerp.bustracker.ui.theme.BusType
import com.schoolerp.bustracker.data.local.StopEntity
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The stops, drawn to scale, with no map underneath them.
 *
 * There is no basemap and no tile server here, and the caption says so rather
 * than letting a driver read an empty background as "the roads have not loaded
 * yet". What it is good for is the one question a driver actually has — am I
 * near the stop I think I am near — and for that, dots at true relative
 * positions plus a scale bar are honest and sufficient.
 *
 * Longitude is scaled by cos(latitude) so the shape is not stretched. Over a
 * school route that is the difference between a recognisable arrangement of
 * stops and a smear.
 */
@Composable
fun RouteSketch(
    stops: List<StopEntity>,
    modifier: Modifier = Modifier,
) {
    val located = stops.filter { it.latitude != null && it.longitude != null }
    if (located.size < 2) return

    val outline = MaterialTheme.colorScheme.outline
    val visited = MaterialTheme.colorScheme.primary
    val pending = MaterialTheme.colorScheme.secondary

    val lats = located.map { it.latitude!! }
    val lons = located.map { it.longitude!! }
    val midLat = (lats.min() + lats.max()) / 2
    val lonScale = cos(Math.toRadians(midLat))

    // Metres across the widest axis, so the scale bar can state a real number.
    val spanMetresX = Geo.metresBetween(midLat, lons.min(), midLat, lons.max())
    val spanMetresY = Geo.metresBetween(lats.min(), lons.min(), lats.max(), lons.min())

    Column(modifier) {
        val reached = stops.count { it.arrivedAtMillis != null }
        val next = stops.firstOrNull { it.arrivedAtMillis == null }?.name
        val description = "Route sketch: ${stops.size} stops, $reached reached" +
            (next?.let { ", next $it" } ?: ", all reached")
        Canvas(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                // A canvas is nothing to TalkBack; say what it draws.
                .semantics { contentDescription = description },
        ) {
            val padding = 24f
            val w = size.width - padding * 2
            val h = size.height - padding * 2

            val xRange = max((lons.max() - lons.min()) * lonScale, 1e-6)
            val yRange = max(lats.max() - lats.min(), 1e-6)
            // One scale for both axes, or the sketch would lie about distance.
            val unitsPerPixel = max(xRange / w, yRange / h)

            fun project(lat: Double, lon: Double): Offset {
                val x = ((lon - lons.min()) * lonScale / unitsPerPixel).toFloat()
                // Screen y grows downwards; north should be up.
                val y = h - ((lat - lats.min()) / unitsPerPixel).toFloat()
                return Offset(padding + x, padding + y)
            }

            val points = located.sortedBy { it.sequence }.map { project(it.latitude!!, it.longitude!!) }
            points.zipWithNext { a, b ->
                drawLine(outline, a, b, strokeWidth = 3f)
            }
            located.sortedBy { it.sequence }.forEachIndexed { index, stop ->
                val point = points[index]
                val done = stop.arrivedAtMillis != null
                drawCircle(if (done) visited else pending, radius = if (done) 10f else 7f, center = point)
                if (!done) {
                    drawCircle(pending, radius = 7f, center = point, style = Stroke(width = 2f))
                }
            }

            // Scale bar: 100 px of the drawing, stated in metres of ground.
            val metresPerUnit = if (xRange > 0) spanMetresX / xRange else 0.0
            val metresPerPixel = metresPerUnit * unitsPerPixel
            val barMetres = niceRound(metresPerPixel * 100)
            val barPixels = if (metresPerPixel > 0) (barMetres / metresPerPixel).toFloat() else 0f
            if (barPixels > 10f) {
                val y = size.height - 8f
                drawLine(outline, Offset(padding, y), Offset(padding + barPixels, y), strokeWidth = 3f)
                drawLine(outline, Offset(padding, y - 5f), Offset(padding, y + 5f), strokeWidth = 3f)
                drawLine(
                    outline,
                    Offset(padding + barPixels, y - 5f),
                    Offset(padding + barPixels, y + 5f),
                    strokeWidth = 3f,
                )
            }
        }

        Text(
            stringResource(R.string.sketch_caption, humanMetres(maxOf(spanMetresX, spanMetresY))),
            style = BusType.small,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** 1, 2 or 5 times a power of ten, so a scale bar reads as a number and not a measurement. */
internal fun niceRound(value: Double): Double {
    if (value <= 0) return 0.0
    var magnitude = 1.0
    while (magnitude * 10 <= value) magnitude *= 10
    while (magnitude > value) magnitude /= 10
    return when {
        magnitude * 5 <= value -> magnitude * 5
        magnitude * 2 <= value -> magnitude * 2
        else -> magnitude
    }
}

internal fun humanMetres(metres: Double): String =
    if (metres >= 1000) "${(metres / 100).roundToInt() / 10.0} km" else "${metres.roundToInt()} m"
