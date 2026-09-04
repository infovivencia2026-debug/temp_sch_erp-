package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.Dash
import com.google.android.gms.maps.model.Gap
import com.google.android.gms.maps.model.JointType
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.RoundCap
import com.google.maps.android.compose.CameraMoveStartedReason
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.MarkerComposable
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import com.google.maps.android.compose.rememberUpdatedMarkerState
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.navigation.Guidance
import com.schoolerp.bustracker.navigation.LatLng
import com.schoolerp.bustracker.ui.theme.BusType
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import com.google.android.gms.maps.model.LatLng as GmsLatLng

/**
 * The map under the bus.
 *
 * Google Maps, through the maps-compose bindings: the stops, the bus and the
 * route are composables on the map rather than a canvas overlay, and the map
 * engine does the rotation, the clipping and the labels. It replaced the
 * OpenStreetMap view, which in turn replaced [RouteSketch], whose caption
 * admitted it carried no map data.
 *
 * Two cameras. FOLLOW is the driving view: zoomed to the street, turned so
 * the way the bus is going is up, and the bus in the lower third so most of
 * the screen is road ahead, which is what a phone on a dashboard is for.
 * OVERVIEW is north-up with the whole route in frame, for the yard. A finger
 * on the map stops the camera moving until Recentre is pressed: a map that
 * snaps back the moment the driver looks at the next junction is a map that
 * fights him.
 *
 * The app's own location pipeline feeds the bus position, so the map's blue
 * dot is off; a second, differently-filtered position under the bus arrow
 * would be two answers to one question.
 */
@Composable
fun RouteMap(
    stops: List<StopEntity>,
    guidance: Guidance?,
    muted: Boolean,
    onMuteChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    /** The map is the whole screen, not a card in a column: no fixed height, no rounded corners. */
    fillScreen: Boolean = false,
    /** Room under the camera buttons for a sheet that peeks over the map's bottom edge. */
    controlsBottomPadding: Dp = 0.dp,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val scheme = MaterialTheme.colorScheme
    val palette = remember(scheme) {
        Palette(
            done = scheme.outline,
            pending = scheme.secondary,
            next = scheme.primary,
            label = scheme.onPrimary,
            bus = scheme.error,
        )
    }

    var mode by remember { mutableStateOf(Camera.FOLLOW) }
    var panned by remember { mutableStateOf(false) }
    var fitStamp by remember { mutableIntStateOf(0) }
    /** Which "fit the route" request has been honoured. */
    var fitted by remember { mutableIntStateOf(-1) }
    var mapSize by remember { mutableStateOf(IntSize.Zero) }
    var bannerHeightPx by remember { mutableIntStateOf(0) }

    val cameraPositionState = rememberCameraPositionState()

    /* A finger on the map. The camera reports why it started moving; only a
       gesture counts, so the app's own animations never lock themselves out. */
    LaunchedEffect(cameraPositionState) {
        snapshotFlow { cameraPositionState.isMoving to cameraPositionState.cameraMoveStartedReason }
            .collect { (moving, reason) ->
                if (moving && reason == CameraMoveStartedReason.GESTURE) panned = true
            }
    }

    val dark = isSystemInDarkTheme()
    val properties = remember(dark) {
        MapProperties(
            isMyLocationEnabled = false,
            isTrafficEnabled = false,
            isIndoorEnabled = false,
            isBuildingEnabled = false,
            minZoomPreference = 4f,
            maxZoomPreference = 20f,
            // Google's day style at night is a white screen a metre from the
            // driver's face; the bundled style dims it to the dashboard.
            mapStyleOptions = if (dark) MapStyleOptions.loadRawResourceStyle(context, R.raw.map_style_night) else null,
        )
    }
    val uiSettings = remember {
        MapUiSettings(
            // The compass is the one control kept: it is how a driver gets
            // back to north-up after the map has turned with the bus.
            compassEnabled = true,
            zoomControlsEnabled = false,
            myLocationButtonEnabled = false,
            mapToolbarEnabled = false,
            indoorLevelPickerEnabled = false,
            tiltGesturesEnabled = false,
        )
    }

    val located = stops.filter { it.latitude != null && it.longitude != null }.sortedBy { it.sequence }
    val nextId = stops.firstOrNull { it.arrivedAtMillis == null }?.stopId
    val bus = guidance?.bus
    val headingDeg = guidance?.headingDeg
    val description = "Map: ${located.size} stops" +
        (nextId?.let { id -> located.firstOrNull { it.stopId == id }?.let { ", next ${it.name}" } } ?: "") +
        (if (bus != null) ", bus shown" else ", waiting for the bus's position")

    /* Most of the screen, and never less than the height that fits a
       junction: this is the navigator, and a map the height of a card is a
       map the driver zooms out of to see anything. */
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    val shape = MaterialTheme.shapes.medium
    val sized = if (fillScreen) {
        modifier.fillMaxSize()
    } else {
        modifier
            .height((screenHeight * 0.55f).coerceAtLeast(360.dp))
            .clip(shape)
    }

    /* The banner and the sheet both sit on the map. Telling the map so
       keeps its own furniture (compass, Google's logo) out from under them,
       and makes "the centre of the map" mean the centre of the part the
       driver can see, which is what the camera arithmetic below works in. */
    val bannerHeight = with(density) { bannerHeightPx.toDp() }
    val contentPadding = PaddingValues(top = bannerHeight, bottom = controlsBottomPadding)
    val bottomPaddingPx = with(density) { controlsBottomPadding.roundToPx() }

    /* The camera. Runs again on every fix in FOLLOW, so the bus stays in
       frame; runs once per request in OVERVIEW, so a fit does not repeat
       under the driver's finger every time a stop is ticked. */
    LaunchedEffect(mode, fitStamp, panned, bus, headingDeg, located, mapSize, bannerHeightPx, bottomPaddingPx) {
        if (panned || mapSize == IntSize.Zero) return@LaunchedEffect
        val visibleHeight = (mapSize.height - bannerHeightPx - bottomPaddingPx).takeIf { it > 0 } ?: return@LaunchedEffect
        when (mode) {
            Camera.FOLLOW -> if (bus != null) {
                cameraPositionState.animate(
                    CameraUpdateFactory.newCameraPosition(followCamera(bus, headingDeg ?: 0.0, visibleHeight)),
                    FOLLOW_ANIMATION_MS,
                )
            } else if (fitted != fitStamp) {
                // Nothing to follow yet: show the route until there is.
                fitAll(cameraPositionState, located, null, mapSize)
                fitted = fitStamp
            }
            Camera.OVERVIEW -> if (fitted != fitStamp) {
                fitAll(cameraPositionState, located, bus, mapSize)
                fitted = fitStamp
            }
        }
    }

    Box(sized.clipToBounds()) {
        GoogleMap(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { mapSize = it },
            cameraPositionState = cameraPositionState,
            contentDescription = description,
            properties = properties,
            uiSettings = uiSettings,
            contentPadding = contentPadding,
        ) {
            RouteLine(
                line = guidance?.line ?: located.map { LatLng(it.latitude!!, it.longitude!!) },
                roadFollowing = guidance?.roadFollowing ?: false,
                density = density.density,
            )
            located.forEachIndexed { index, stop ->
                key(stop.stopId) {
                    StopMarker(
                        stop = stop,
                        number = index + 1,
                        done = stop.arrivedAtMillis != null,
                        isNext = stop.stopId == nextId,
                        palette = palette,
                    )
                }
            }
            if (bus != null) {
                BusMarker(bus = bus, headingDeg = headingDeg, palette = palette)
            }
        }

        /* The banner sits on the map, at its top edge, the way a car's
           navigator draws it: one view, not a card and then a map. */
        NavigationBanner(
            guidance = guidance,
            muted = muted,
            onMuteChange = onMuteChange,
            modifier = Modifier
                .align(Alignment.TopCenter)
                // Measured outside the paddings below, so the figure is the
                // whole strip the banner takes off the top of the map.
                .onSizeChanged { bannerHeightPx = it.height }
                // Edge to edge when it fills the screen: keep the banner out
                // from under the status bar.
                .then(if (fillScreen) Modifier.statusBarsPadding() else Modifier)
                .padding(8.dp),
        )

        /* Stacked in the corner, not laid across the bottom: the bus sits in
           the lower third of the map, and a row of buttons there covered it. */
        Column(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 8.dp + controlsBottomPadding),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            horizontalAlignment = Alignment.End,
        ) {
            // Opaque on the tiles, and never under 48dp: these are pressed
            // with the bus moving.
            val buttonColors = ButtonDefaults.outlinedButtonColors(
                containerColor = scheme.surface,
                contentColor = scheme.onSurface,
            )
            val small = PaddingValues(horizontal = 16.dp, vertical = 0.dp)
            if (panned) {
                OutlinedButton(
                    onClick = {
                        panned = false
                        fitStamp++
                    },
                    colors = buttonColors,
                    contentPadding = small,
                    modifier = Modifier.height(48.dp),
                ) { Text(stringResource(R.string.map_recentre), style = BusType.small) }
            }
            OutlinedButton(
                onClick = {
                    mode = if (mode == Camera.FOLLOW) Camera.OVERVIEW else Camera.FOLLOW
                    panned = false
                    fitStamp++
                },
                colors = buttonColors,
                contentPadding = small,
                modifier = Modifier.height(48.dp),
            ) {
                Text(
                    stringResource(if (mode == Camera.FOLLOW) R.string.map_whole else R.string.map_follow),
                    style = BusType.small,
                )
            }
        }
    }
}

private enum class Camera { FOLLOW, OVERVIEW }

private class Palette(val done: Color, val pending: Color, val next: Color, val label: Color, val bus: Color)

private const val FOLLOW_ZOOM = 17f
private const val FOLLOW_ANIMATION_MS = 700
private const val FIT_PADDING_DP = 64
private const val EARTH_RADIUS_M = 6_371_000.0

/**
 * Heading up, bus in the lower third.
 *
 * Rotation does the work a tilted camera does in a car's navigator: the road
 * ahead is up the screen whichever way the bus is pointing. The centre is
 * set a sixth of the visible height *ahead* of the bus along its heading,
 * which puts the bus two thirds of the way down. Metres per pixel at the
 * follow zoom is Web Mercator's, which is what the map draws in.
 */
private fun followCamera(bus: LatLng, headingDeg: Double, visibleHeightPx: Int): CameraPosition {
    val metresPerPixel = 156_543.03392 * cos(Math.toRadians(bus.latitude)) / 2.0.pow(FOLLOW_ZOOM.toDouble())
    val aheadMetres = (visibleHeightPx / 6.0) * metresPerPixel
    val centre = destination(bus, aheadMetres, headingDeg)
    return CameraPosition.Builder()
        .target(centre.gms())
        .zoom(FOLLOW_ZOOM)
        .bearing(((headingDeg % 360.0) + 360.0).rem(360.0).toFloat())
        .tilt(0f)
        .build()
}

/** The point [metres] along [bearingDeg] from [from], on a spherical earth. */
private fun destination(from: LatLng, metres: Double, bearingDeg: Double): LatLng {
    val d = metres / EARTH_RADIUS_M
    val brng = Math.toRadians(bearingDeg)
    val lat1 = Math.toRadians(from.latitude)
    val lon1 = Math.toRadians(from.longitude)
    val lat2 = asin(sin(lat1) * cos(d) + cos(lat1) * sin(d) * cos(brng))
    val lon2 = lon1 + atan2(sin(brng) * sin(d) * cos(lat1), cos(d) - sin(lat1) * sin(lat2))
    return LatLng(Math.toDegrees(lat2), Math.toDegrees(lon2))
}

private suspend fun fitAll(
    camera: com.google.maps.android.compose.CameraPositionState,
    stops: List<StopEntity>,
    bus: LatLng?,
    size: IntSize,
) {
    val points = stops.map { GmsLatLng(it.latitude!!, it.longitude!!) } +
        listOfNotNull(bus?.gms())
    if (points.isEmpty()) return
    if (points.size == 1) {
        camera.move(
            CameraUpdateFactory.newCameraPosition(
                CameraPosition.Builder().target(points.first()).zoom(16f).bearing(0f).tilt(0f).build(),
            ),
        )
        return
    }
    val box = LatLngBounds.builder().apply { points.forEach { include(it) } }.build()
    // North-up first: a bounds fit keeps whatever bearing the camera had, and
    // the overview is the yard's map, not the driver's.
    val now = camera.position
    camera.move(
        CameraUpdateFactory.newCameraPosition(
            CameraPosition.Builder().target(now.target).zoom(now.zoom).bearing(0f).tilt(0f).build(),
        ),
    )
    // The sized variant: the plain one throws before the map has laid out.
    camera.move(CameraUpdateFactory.newLatLngBounds(box, size.width, size.height, FIT_PADDING_DP))
}

private fun LatLng.gms() = GmsLatLng(latitude, longitude)

/**
 * The route: a light casing under a blue road line, the pair Google's own
 * navigator draws. Straight lines between stops are dashed, so the driver
 * can see the difference between "this road" and "that way".
 */
@Composable
private fun RouteLine(line: List<LatLng>, roadFollowing: Boolean, density: Float) {
    if (line.size < 2) return
    val points = remember(line) { line.map { it.gms() } }
    val dashes = if (roadFollowing) null else listOf(Dash(14f * density), Gap(10f * density))
    Polyline(
        points = points,
        color = Color(0xFFA8C7FA),
        width = 13f * density,
        pattern = dashes,
        startCap = RoundCap(),
        endCap = RoundCap(),
        jointType = JointType.ROUND,
        zIndex = 0f,
    )
    Polyline(
        points = points,
        color = Color(0xFF1A73E8),
        width = 8f * density,
        pattern = dashes,
        startCap = RoundCap(),
        endCap = RoundCap(),
        jointType = JointType.ROUND,
        zIndex = 1f,
    )
}

/**
 * A numbered disc. Not flat, so it faces the screen and the number stays
 * upright when the map turns with the bus; a "3" lying on its side is a "3"
 * the driver has to think about. The next stop is bigger and in the primary
 * colour; a stop already called is greyed.
 */
@Composable
private fun StopMarker(stop: StopEntity, number: Int, done: Boolean, isNext: Boolean, palette: Palette) {
    val state = rememberUpdatedMarkerState(GmsLatLng(stop.latitude!!, stop.longitude!!))
    val fill = when {
        done -> palette.done
        isNext -> palette.next
        else -> palette.pending
    }
    val diameter = if (isNext) 32.dp else 24.dp
    MarkerComposable(
        number, done, isNext, fill, palette.label,
        state = state,
        title = stop.name,
        anchor = Offset(0.5f, 0.5f),
        zIndex = if (isNext) 3f else 2f,
    ) {
        Box(
            modifier = Modifier.size(diameter + 4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(diameter)) {
                drawCircle(fill)
                drawCircle(Color.White, style = Stroke(width = 2.5.dp.toPx()))
            }
            Text(
                text = number.toString(),
                color = palette.label,
                fontSize = if (isNext) 15.sp else 12.sp,
                lineHeight = if (isNext) 15.sp else 12.sp,
                textAlign = TextAlign.Center,
                style = BusType.small,
            )
        }
    }
}

/**
 * The bus: an arrowhead in the error colour, nothing like a stop. Flat on
 * the map and rotated by the heading, so it points where the bus points in
 * the map's own frame -- which, in FOLLOW, is straight up the screen.
 */
@Composable
private fun BusMarker(bus: LatLng, headingDeg: Double?, palette: Palette) {
    val state = rememberUpdatedMarkerState(bus.gms())
    MarkerComposable(
        palette.bus,
        state = state,
        anchor = Offset(0.5f, 0.5f),
        flat = true,
        rotation = (headingDeg ?: 0.0).toFloat(),
        zIndex = 4f,
    ) {
        Canvas(Modifier.size(40.dp)) {
            val x = size.width / 2
            val y = size.height / 2
            val unit = 14.dp.toPx()
            val path = Path().apply {
                moveTo(x, y - unit * 1.4f)
                lineTo(x + unit, y + unit)
                lineTo(x, y + unit * 0.45f)
                lineTo(x - unit, y + unit)
                close()
            }
            drawPath(path, palette.bus)
            drawPath(path, Color.White, style = Stroke(width = 3.dp.toPx(), join = StrokeJoin.Round))
        }
    }
}
