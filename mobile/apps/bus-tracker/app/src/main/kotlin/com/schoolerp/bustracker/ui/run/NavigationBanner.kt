package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.navigation.Guidance
import com.schoolerp.bustracker.navigation.Navigator
import com.schoolerp.bustracker.ui.theme.BusType
import kotlin.math.roundToInt

/**
 * The next thing to do, in the type a driver reads at a junction.
 *
 * Arrow, distance, road: the order a car's navigator uses, because it is the
 * order the eye wants them in. "In 200 m" is the line read at speed; the
 * road name confirms it once the sign is visible. Below, in smaller type, the
 * stop the bus is heading for with how far and how long -- reference, not
 * instruction, so it must not compete with the line above it.
 *
 * Drawn on the accent, the one surface on the map that is the school's
 * colour, so it is found in a glance against whatever the tiles are doing.
 */
@Composable
fun NavigationBanner(
    guidance: Guidance?,
    muted: Boolean,
    onMuteChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(scheme.primary)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val maneuver = guidance?.maneuver
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when {
                guidance == null -> Text(
                    stringResource(R.string.nav_finding),
                    style = BusType.display,
                    color = scheme.onPrimary,
                )
                guidance.bus == null -> Text(
                    stringResource(R.string.nav_waiting),
                    style = BusType.display,
                    color = scheme.onPrimary,
                )
                guidance.arriving -> Column {
                    Text(stringResource(R.string.nav_arriving), style = BusType.body, color = scheme.onPrimary)
                    Text(
                        guidance.nextStopName,
                        style = BusType.display,
                        color = scheme.onPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                maneuver == null || maneuver.type == "arrive" -> {
                    val distance = maneuver?.distanceM ?: guidance.nextStopDistanceM
                    ManeuverArrow(0f, scheme.onPrimary)
                    Column {
                        Text(
                            distance?.let { stringResource(R.string.nav_in, Navigator.humanDistance(it)) }
                                ?: stringResource(R.string.nav_ahead),
                            style = BusType.display,
                            color = scheme.onPrimary,
                        )
                        Text(
                            guidance.nextStopName,
                            style = BusType.body,
                            color = scheme.onPrimary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                else -> {
                    ManeuverArrow(maneuver.arrowDegrees, scheme.onPrimary)
                    Column {
                        Text(
                            stringResource(R.string.nav_in, Navigator.humanDistance(maneuver.distanceM)),
                            style = BusType.display,
                            color = scheme.onPrimary,
                        )
                        Text(
                            maneuver.roadName.ifBlank { maneuver.instruction },
                            style = BusType.body,
                            color = scheme.onPrimary,
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
            val line = if (guidance != null) {
                buildString {
                    append(stringResource(R.string.nav_next, guidance.nextStopName))
                    guidance.nextStopDistanceM?.let { append(", ").append(Navigator.humanDistance(it)) }
                    guidance.etaSeconds?.let { append(", ").append(humanMinutes(it)) }
                    if (guidance.offRoute) append(". ").append(stringResource(R.string.nav_off_route))
                    if (!guidance.roadFollowing) append(". ").append(stringResource(R.string.nav_no_directions))
                }
            } else {
                stringResource(R.string.nav_no_signal)
            }
            Text(line, style = BusType.small, color = scheme.onPrimary, modifier = Modifier.weight(1f))
            TextButton(
                onClick = { onMuteChange(!muted) },
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.onPrimary),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(if (muted) R.string.unmute else R.string.mute), style = BusType.small) }
        }
    }
}

/** "4 min", or "1 hr 5 min". Never seconds: a bus does not have those. */
@Composable
private fun humanMinutes(seconds: Double): String {
    val minutes = (seconds / 60).roundToInt().coerceAtLeast(1)
    return if (minutes >= 60) {
        stringResource(R.string.nav_hours_minutes, minutes / 60, minutes % 60)
    } else {
        stringResource(R.string.nav_minutes, minutes)
    }
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
