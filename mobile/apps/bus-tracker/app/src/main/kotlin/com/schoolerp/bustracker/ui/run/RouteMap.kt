package com.schoolerp.bustracker.ui.run

import android.content.Context
import android.widget.FrameLayout
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Point
import android.view.MotionEvent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.navigation.Guidance
import com.schoolerp.bustracker.navigation.LatLng
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.Projection
import org.osmdroid.views.overlay.Overlay
import java.io.File

/**
 * The map under the bus.
 *
 * OpenStreetMap tiles through osmdroid, which is the same imagery the school's
 * own web map draws: no key, no billing, and a driver and the office looking
 * at the same roads. It replaced [RouteSketch], whose caption admitted it
 * carried no map data -- honest, and no use to a driver put on a route he
 * has never driven, which is the case navigation exists for.
 *
 * Two cameras. FOLLOW is the driving view: zoomed to the street, turned so
 * the way the bus is going is up, and the bus in the lower third so most of
 * the screen is road ahead, which is what a phone on a dashboard is for.
 * OVERVIEW is north-up with the whole route in frame, for the yard. A finger
 * on the map stops the camera moving until Recentre is pressed: a map that
 * snaps back the moment the driver looks at the next junction is a map that
 * fights him.
 */
@Composable
fun RouteMap(
    stops: List<StopEntity>,
    guidance: Guidance?,
    muted: Boolean,
    onMuteChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scheme = MaterialTheme.colorScheme
    val palette = remember(scheme) {
        Palette(
            done = scheme.outline.toArgb(),
            pending = scheme.secondary.toArgb(),
            next = scheme.primary.toArgb(),
            label = scheme.onPrimary.toArgb(),
            bus = scheme.error.toArgb(),
        )
    }

    var mode by remember { mutableStateOf(Camera.FOLLOW) }
    var panned by remember { mutableStateOf(false) }
    var fitStamp by remember { mutableStateOf(0) }

    val map = remember {
        osmdroidReady(context)
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            zoomController.setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER)
            isTilesScaledToDpi = true
            minZoomLevel = 4.0
            maxZoomLevel = 20.0
            isHorizontalMapRepetitionEnabled = false
            isVerticalMapRepetitionEnabled = false
        }
    }
    val overlay = remember { RunOverlay(palette, context.resources.displayMetrics.density) }
    val touch = remember { TouchOverlay { panned = true } }

    DisposableEffect(map, lifecycleOwner) {
        map.overlays.add(overlay)
        map.overlays.add(touch)
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> map.onResume()
                Lifecycle.Event.ON_PAUSE -> map.onPause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            map.onDetach()
        }
    }

    val located = stops.filter { it.latitude != null && it.longitude != null }.sortedBy { it.sequence }
    val nextId = stops.firstOrNull { it.arrivedAtMillis == null }?.stopId
    val bus = guidance?.bus
    val description = "Map: ${located.size} stops" +
        (nextId?.let { id -> located.firstOrNull { it.stopId == id }?.let { ", next ${it.name}" } } ?: "") +
        (if (bus != null) ", bus shown" else ", waiting for the bus's position")

    /* CLIPPED, TWICE.

       osmdroid rotates the whole canvas to turn the map heading-up, and it
       draws the rotated square without clipping it to its own bounds: it
       relies on whoever holds it to do that. Nothing did. The tiles and the
       route line painted over the banner above, the route heading above
       that, and down across the next-stop card -- a tilted square of map
       bleeding across the screen. Compose clips the Box to the card shape
       and to its bounds, and the FrameLayout on the View side clips its
       child as well, because Compose's clip does not reach into a View's
       own canvas the way a ViewGroup's clipChildren does.

       Most of the screen, and never less than the height that fits a
       junction: this is the navigator, and a map the height of a card is a
       map the driver zooms out of to see anything. */
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    val shape = MaterialTheme.shapes.medium
    Box(
        modifier
            .height((screenHeight * 0.55f).coerceAtLeast(360.dp))
            .clip(shape)
            .clipToBounds(),
    ) {
        AndroidView(
            factory = { ctx ->
                FrameLayout(ctx).apply {
                    clipChildren = true
                    clipToPadding = true
                    addView(map, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .clipToBounds()
                .semantics { contentDescription = description },
            update = { _ ->
                val view = map
                overlay.stops = located
                overlay.nextStopId = nextId
                overlay.line = guidance?.line ?: located.map { LatLng(it.latitude!!, it.longitude!!) }
                overlay.roadFollowing = guidance?.roadFollowing ?: false
                overlay.bus = bus
                overlay.headingDeg = guidance?.headingDeg
                view.invalidate()

                if (panned) return@AndroidView
                when (mode) {
                    Camera.FOLLOW -> if (bus != null) {
                        followCamera(view, bus, guidance?.headingDeg ?: 0.0)
                    } else if (fitStamp != overlay.fitted) {
                        // Nothing to follow yet: show the route until there is.
                        fitAll(view, located, null)
                        overlay.fitted = fitStamp
                    }
                    Camera.OVERVIEW -> if (fitStamp != overlay.fitted) {
                        fitAll(view, located, bus)
                        overlay.fitted = fitStamp
                    }
                }
            },
        )

        /* The banner sits on the map, at its top edge, the way a car's
           navigator draws it: one view, not a card and then a map. */
        NavigationBanner(
            guidance = guidance,
            muted = muted,
            onMuteChange = onMuteChange,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(8.dp),
        )

        /* Stacked in the corner, not laid across the bottom: the bus sits in
           the lower third of the map, and a row of buttons there covered it. */
        Column(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            horizontalAlignment = Alignment.End,
        ) {
            val buttonColors = ButtonDefaults.outlinedButtonColors(containerColor = scheme.surface)
            val small = PaddingValues(horizontal = 12.dp, vertical = 0.dp)
            if (panned) {
                OutlinedButton(
                    onClick = {
                        panned = false
                        fitStamp++
                    },
                    colors = buttonColors,
                    contentPadding = small,
                    modifier = Modifier.height(36.dp),
                ) { Text("Recentre", style = MaterialTheme.typography.labelLarge) }
            }
            OutlinedButton(
                onClick = {
                    mode = if (mode == Camera.FOLLOW) Camera.OVERVIEW else Camera.FOLLOW
                    panned = false
                    fitStamp++
                },
                colors = buttonColors,
                contentPadding = small,
                modifier = Modifier.height(36.dp),
            ) {
                Text(
                    if (mode == Camera.FOLLOW) "Whole route" else "Follow bus",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

private enum class Camera { FOLLOW, OVERVIEW }

private class Palette(val done: Int, val pending: Int, val next: Int, val label: Int, val bus: Int)

private const val FOLLOW_ZOOM = 17.0

/**
 * Heading up, bus in the lower third.
 *
 * osmdroid has no tilt, so rotation does the work a tilted camera does in a
 * car's navigator: the road ahead is up the screen whichever way the bus is
 * pointing. The centre is set a sixth of the view *ahead* of the bus along
 * its heading, which puts the bus two thirds of the way down.
 */
private fun followCamera(map: MapView, bus: LatLng, headingDeg: Double) {
    val here = GeoPoint(bus.latitude, bus.longitude)
    val orientation = ((360.0 - headingDeg) % 360.0).toFloat()
    val height = map.height.takeIf { it > 0 } ?: return
    // Set the zoom first so the metres-per-pixel below is the one the frame
    // will actually be drawn at.
    if (map.zoomLevelDouble != FOLLOW_ZOOM) map.controller.setZoom(FOLLOW_ZOOM)
    val pixelsPerMetre = map.projection.metersToPixels(1f).takeIf { it > 0f } ?: return
    val aheadMetres = (height / 6.0) / pixelsPerMetre
    val centre = here.destinationPoint(aheadMetres, headingDeg)
    map.controller.animateTo(centre, FOLLOW_ZOOM, 700L, orientation)
}

private fun fitAll(map: MapView, stops: List<StopEntity>, bus: LatLng?) {
    val points = stops.map { GeoPoint(it.latitude!!, it.longitude!!) } +
        listOfNotNull(bus?.let { GeoPoint(it.latitude, it.longitude) })
    if (points.isEmpty()) return
    map.setMapOrientation(0f, false)
    if (points.size == 1) {
        map.controller.setZoom(16.0)
        map.controller.setCenter(points.first())
        return
    }
    val box = BoundingBox.fromGeoPointsSafe(points)
    if (map.width > 0 && map.height > 0) {
        map.zoomToBoundingBox(box, false, 64)
    } else {
        // Before layout there is no view to fit; do it on the first one.
        map.addOnFirstLayoutListener { _, _, _, _, _ -> map.zoomToBoundingBox(box, false, 64) }
    }
}

/**
 * osmdroid's global configuration, set before the first MapView exists.
 *
 * The user agent is the load-bearing line: OpenStreetMap's tile servers refuse
 * osmdroid's default one outright, and the map is then a grey grid with no
 * error anywhere a driver would see it. The package name identifies this app
 * the way OSM's usage policy asks. The cache goes under the app's own cache
 * directory rather than osmdroid's default on external storage, which on
 * modern Android is either unwritable or a permission prompt.
 */
private fun osmdroidReady(context: Context) {
    Configuration.getInstance().apply {
        userAgentValue = context.packageName
        osmdroidBasePath = File(context.filesDir, "osmdroid").apply { mkdirs() }
        osmdroidTileCache = File(context.cacheDir, "osmdroid-tiles").apply { mkdirs() }
        // A road tile cached this morning is right this afternoon; keep them.
        expirationExtendedDuration = 7L * 24 * 60 * 60 * 1000
    }
}

/**
 * Sees every touch before the map does, and does two things with it.
 *
 * A finger moving on the map means the driver is looking at something, so
 * the camera is told to leave it alone. And the parent Compose column is told
 * not to intercept: this map sits inside a scrolling screen, and without that
 * a drag across the map scrolled the page instead of panning the map.
 */
private class TouchOverlay(private val onPan: () -> Unit) : Overlay() {
    override fun onTouchEvent(event: MotionEvent, mapView: MapView): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> mapView.parent?.requestDisallowInterceptTouchEvent(true)
            MotionEvent.ACTION_MOVE, MotionEvent.ACTION_POINTER_DOWN -> onPan()
        }
        return false
    }
}

/**
 * Everything drawn over the tiles, in one pass: the route, the stops, the bus.
 *
 * One overlay rather than osmdroid's Marker and Polyline classes because those
 * want drawables, and the whole of what is drawn here is circles, a number and
 * a line. Labels are counter-rotated so they stay upright when the map turns
 * with the bus; a "3" lying on its side is a "3" the driver has to think about.
 */
private class RunOverlay(private val palette: Palette, private val density: Float) : Overlay() {
    var stops: List<StopEntity> = emptyList()
    var nextStopId: String? = null
    var line: List<LatLng> = emptyList()
    var roadFollowing: Boolean = false
    var bus: LatLng? = null
    var headingDeg: Double? = null

    /** Which "fit the route" request has been honoured; see RouteMap. */
    var fitted: Int = -1

    private val casing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.parseColor("#A8C7FA")
    }
    private val road = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.parseColor("#1A73E8")
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.WHITE
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = palette.label
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    private val path = Path()
    private val point = Point()

    override fun draw(canvas: Canvas, projection: Projection) {
        // Not Canvas.density: a hardware canvas reports zero for it.
        drawLine(canvas, projection, density)
        drawStops(canvas, projection, density)
        drawBus(canvas, projection, density)
    }

    private fun drawLine(canvas: Canvas, projection: Projection, density: Float) {
        if (line.size < 2) return
        path.rewind()
        line.forEachIndexed { i, p ->
            projection.toPixels(GeoPoint(p.latitude, p.longitude), point)
            if (i == 0) path.moveTo(point.x.toFloat(), point.y.toFloat())
            else path.lineTo(point.x.toFloat(), point.y.toFloat())
        }
        casing.strokeWidth = 13f * density
        road.strokeWidth = 8f * density
        // Straight lines between stops are drawn as a dashed line, so the
        // driver can see the difference between "this road" and "that way".
        val dashes = if (roadFollowing) null else DashPathEffect(floatArrayOf(14f * density, 10f * density), 0f)
        casing.pathEffect = dashes
        road.pathEffect = dashes
        canvas.drawPath(path, casing)
        canvas.drawPath(path, road)
    }

    private fun drawStops(canvas: Canvas, projection: Projection, density: Float) {
        val orientation = projection.orientation
        stops.forEachIndexed { index, stop ->
            projection.toPixels(GeoPoint(stop.latitude!!, stop.longitude!!), point)
            val x = point.x.toFloat()
            val y = point.y.toFloat()
            val done = stop.arrivedAtMillis != null
            val isNext = stop.stopId == nextStopId
            val radius = (if (isNext) 16f else 12f) * density
            fill.color = when {
                done -> palette.done
                isNext -> palette.next
                else -> palette.pending
            }
            ring.strokeWidth = 2.5f * density
            canvas.drawCircle(x, y, radius, fill)
            canvas.drawCircle(x, y, radius, ring)
            text.textSize = (if (isNext) 15f else 12f) * density
            canvas.save()
            canvas.rotate(-orientation, x, y)
            canvas.drawText("${index + 1}", x, y - (text.ascent() + text.descent()) / 2, text)
            canvas.restore()
        }
    }

    private fun drawBus(canvas: Canvas, projection: Projection, density: Float) {
        val here = bus ?: return
        projection.toPixels(GeoPoint(here.latitude, here.longitude), point)
        val x = point.x.toFloat()
        val y = point.y.toFloat()
        val size = 14f * density
        fill.color = palette.bus
        ring.strokeWidth = 3f * density
        canvas.save()
        // Points where the bus points, in the map's own frame: the canvas is
        // already turned with the map, so heading is applied on top of it.
        canvas.rotate(headingDeg?.toFloat() ?: 0f, x, y)
        path.rewind()
        path.moveTo(x, y - size * 1.4f)
        path.lineTo(x + size, y + size)
        path.lineTo(x, y + size * 0.45f)
        path.lineTo(x - size, y + size)
        path.close()
        canvas.drawPath(path, fill)
        canvas.drawPath(path, ring)
        canvas.restore()
    }
}
