package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.schoolerp.bustracker.navigation.Guidance
import com.schoolerp.bustracker.navigation.Navigator
import kotlin.math.roundToInt

/**
 * The next thing to do, in the type a driver reads at a junction.
 *
 * Arrow, distance, road: the order a car's navigator uses, because it is the
 * order the eye wants them in. "In 200 m" is the line read at speed; the
 * road name confirms it once the sign is visible. Below, in smaller type, the
 * stop the bus is heading for with how far and how long -- reference, not
 * instruction, so it must not compete with the line above it.
 */
@Composable
fun NavigationBanner(
    guidance: Guidance?,
    muted: Boolean,
    onMuteChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = scheme.primary,
            contentColor = scheme.onPrimary,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val maneuver = guidance?.maneuver
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when {
                    guidance == null -> Text(
                        "Finding the route",
                        style = MaterialTheme.typography.headlineSmall,
                    )
                    guidance.bus == null -> Text(
                        "Waiting for the phone's position",
                        style = MaterialTheme.typography.headlineSmall,
                    )
                    guidance.arriving -> Column {
                        Text("Arriving", style = MaterialTheme.typography.titleMedium)
                        Text(
                            guidance.nextStopName,
                            style = MaterialTheme.typography.headlineSmall,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    maneuver == null || maneuver.type == "arrive" -> {
                        val distance = maneuver?.distanceM ?: guidance.nextStopDistanceM
                        ManeuverArrow(0f, scheme.onPrimary)
                        Column {
                            Text(
                                distance?.let { "In ${Navigator.humanDistance(it)}" } ?: "Ahead",
                                style = MaterialTheme.typography.headlineSmall,
                            )
                            Text(
                                guidance.nextStopName,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    else -> {
                        ManeuverArrow(maneuver.arrowDegrees, scheme.onPrimary)
                        Column {
                            Text(
                                "In ${Navigator.humanDistance(maneuver.distanceM)}",
                                style = MaterialTheme.typography.headlineSmall,
                            )
                            Text(
                                maneuver.roadName.ifBlank { maneuver.instruction },
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    buildString {
                        if (guidance != null) {
                            append("Next stop ")
                            append(guidance.nextStopName)
                            guidance.nextStopDistanceM?.let { append(", ").append(Navigator.humanDistance(it)) }
                            guidance.etaSeconds?.let { append(", ").append(humanMinutes(it)) }
                            if (guidance.offRoute) append(". Off the route, finding a new one")
                            if (!guidance.roadFollowing) append(". No directions: straight lines only")
                        } else {
                            append("Directions come from the router when there is signal")
                        }
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = { onMuteChange(!muted) },
                    colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = scheme.onPrimary),
                ) { Text(if (muted) "Unmute" else "Mute") }
            }
        }
    }
}

/** "4 min", or "1 hr 5 min". Never seconds: a bus does not have those. */
private fun humanMinutes(seconds: Double): String {
    val minutes = (seconds / 60).roundToInt().coerceAtLeast(1)
    return if (minutes >= 60) "${minutes / 60} hr ${minutes % 60} min" else "$minutes min"
}

/**
 * One arrow, turned to the manoeuvre. Straight up is "continue"; a right turn
 * is the same arrow at ninety degrees; a U-turn points back at the driver.
 * Drawn rather than glyphs, because the emoji arrows come out in whatever
 * colour the phone's font decides and at whatever weight.
 */
@Composable
private fun ManeuverArrow(degrees: Float, color: Color) {
    Canvas(Modifier.size(56.dp)) {
        val w = size.width
        val h = size.height
        val stroke = w * 0.14f
        rotate(degrees) {
            drawLine(
                color,
                Offset(w / 2, h * 0.9f),
                Offset(w / 2, h * 0.3f),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
            val head = Path().apply {
                moveTo(w / 2, h * 0.08f)
                lineTo(w * 0.2f, h * 0.42f)
                lineTo(w * 0.8f, h * 0.42f)
                close()
            }
            drawPath(head, color)
            drawPath(head, color, style = Stroke(width = stroke * 0.5f))
        }
    }
}
