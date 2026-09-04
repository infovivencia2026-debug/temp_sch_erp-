package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import com.journeyapps.barcodescanner.ScanContract
import com.schoolerp.bustracker.ui.scan.BusScanActivity
import com.journeyapps.barcodescanner.ScanOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.engine.Headcount
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.ui.LocationPermissionPrompt
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import com.schoolerp.bustracker.core.BtLog
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation

/**
 * One screen, two states: a run is open, or it is not. Everything on it answers
 * a question a driver would ask out loud — which bus am I, is the school seeing
 * me, and what happens if I lose signal.
 */
@Composable
fun RunScreen(viewModel: RunViewModel = hiltViewModel()) {
    val status by viewModel.status.collectAsStateWithLifecycle()
    val stops by viewModel.stops.collectAsStateWithLifecycle()
    val routes by viewModel.routeBook.collectAsStateWithLifecycle()
    val scannedBus by viewModel.scannedBus.collectAsStateWithLifecycle()
    val students by viewModel.students.collectAsStateWithLifecycle()
    val pendingMarks by viewModel.pendingMarks.collectAsStateWithLifecycle()
    val notices by viewModel.notices.collectAsStateWithLifecycle()
    val alert by viewModel.alert.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val lastArrival by viewModel.lastArrival.collectAsStateWithLifecycle()
    val signedIn by viewModel.signedIn.collectAsStateWithLifecycle()
    val guidance by viewModel.guidance.collectAsStateWithLifecycle()
    val voiceMuted by viewModel.voiceMuted.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var settingsOpen by rememberSaveable { mutableStateOf(false) }

    // Some ROMs ship without the settings screens these intents name, and an
    // unhandled ActivityNotFoundException took the run screen down with it.
    fun open(intent: android.content.Intent) {
        runCatching { context.startActivity(intent) }
            .onFailure { BtLog.w("ui", "no activity for ${intent.action}", it) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        /* THE HEADING IS THE SCHOOL, AND THAT IS ALL.

           It used to be the bus registration in display type with the school
           under it -- from when a phone was one bus for ever. A phone is now a
           driver's, and the bus is whatever he scans this morning, so putting
           a registration at the top of the app states something that is not
           true until a run opens. The bus belongs to the run, and that is
           where it is now shown. */
        status.institution?.let {
            Text(it, style = MaterialTheme.typography.titleMedium)
        }

        NoticeBanner(notices, onAcknowledge = viewModel::acknowledgeNotice)

        ReportingCard(status)

        /* PHONE SETUP, ON ITS OWN SCREEN.

           Location, battery and notifications each had a full-width card with
           a headline and a paragraph, stacked above the only two controls the
           driver came for. On a handset that is three screenfuls of settings
           advice before the Start button, every morning, for ever -- and the
           app looked broken because it opened on a wall of warnings.

           They were then folded behind one line that expanded in place, which
           pushed the Start button off the bottom the moment it was opened.
           Now the line counts them and opens a screen of its own -- the whole
           display, with a Back control, not a dialog squeezed into the middle of
           the run -- and the rarer controls (stopping the tracker, changing
           driver) live there too instead of trailing under End Run. A driver
           whose phone is set up correctly still sees one quiet line. */
        TextButton(onClick = { settingsOpen = true }) {
            Text(
                phoneSetupSummary(status),
                textDecoration = TextDecoration.Underline,
            )
        }

        /* THE SHIFT.
         *
         * Above Start rather than in front of the whole app. Pairing is the
         * office's job and is done once; signing in is the driver's and is
         * done every morning, and the moment it matters is when a run is about
         * to open -- the server refuses trip start without it and answers 401.
         *
         * A login wall in front of the app would also mean a phone picked up
         * mid-run shows a form instead of the route, which is the worst moment
         * for it. */
        /* ONE THING AT A TIME.

           Sign-in and Start-a-run were both drawn whenever no run was open, so
           a driver who had not signed in was shown a login form, a bus field,
           a route list, a direction toggle and a route-setup form together --
           and the Start button he could not use yet was the one below the fold.

           Signing in is the step in front; the run is the step after. Drawing
           the second before the first is done is what made the screen look
           like a settings page instead of a two-tap morning. */
        val trip = status.trip
        if (trip == null && !signedIn) {
            DriverSignIn(
                signedIn = false,
                driverName = viewModel.driverName,
                busy = busy,
                onSignIn = viewModel::signIn,
                onSignOut = viewModel::signOut,
            )
        }

        if (trip == null && signedIn) {
            StartRunSection(
                routes = routes,
                busy = busy,
                bus = scannedBus,
                onBusScanned = viewModel::onBusScanned,
                onStart = viewModel::startRun,
                onRemoveRoute = viewModel::removeRoute,
            )
        }

        /* THE RUN ITSELF, and its own branch rather than an else.

           This was the `else` of "no run and signed in", so it also caught the
           driver who had not signed in yet: the compiler stopped it, because
           trip is nullable there and every line below reads it. Splitting the
           three states apart is what the screen was restructured for in the
           first place - sign in, then start, then drive - and an else could
           only ever express two of them. */
        if (trip != null) {
            Text(
                "${trip.routeName.ifBlank { "Route" }}, " +
                    if (trip.direction == DIRECTION_DROP) "drop" else "pickup",
                style = MaterialTheme.typography.titleLarge,
            )

            /* The one question the driver has while moving, answered first
               and in the largest type on the screen. Everything under it is
               reference; this is the line read at a junction. */
            val counts = students.groupBy { it.stopId }
                .mapValues { (_, here) -> Headcount.of(here, trip.direction) }

            /* THE NAVIGATOR, before the roster.

               The sketch drew the stops to scale on a blank background and
               said in its caption that it carried no map data. True, and no
               help: a driver on a route he had not driven could see the next
               stop was north-east and nothing about which road got him there.
               This is the banner and the map a car's navigator shows, fed by
               the run's own fixes, and it comes first because it is what the
               screen is looked at for while the bus is moving.

               The sketch stays as the fallback for a phone with no signal or a
               route with no coordinates: tiles cannot be fetched with no
               network, and a grey grid would read as the app being broken. */
            val located = stops.filter { it.latitude != null && it.longitude != null }
            val next = stops.firstOrNull { it.arrivedAtMillis == null }
            if (located.isNotEmpty() && status.hasNetwork) {
                // The banner is drawn on the map, at its top edge.
                RouteMap(
                    stops = stops,
                    guidance = guidance,
                    muted = voiceMuted,
                    onMuteChange = viewModel::setVoiceMuted,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                if (located.isNotEmpty() && next != null) {
                    NavigationBanner(
                        guidance = guidance,
                        muted = voiceMuted,
                        onMuteChange = viewModel::setVoiceMuted,
                    )
                }
                RouteSketch(stops, modifier = Modifier.fillMaxWidth())
            }

            NextStopCard(
                stops = stops,
                lastArrival = lastArrival,
                counts = counts,
                direction = trip.direction,
                onNavigate = next?.takeIf { it.latitude != null && it.longitude != null }?.let { stop ->
                    {
                        /* The phone's own maps app, for a driver who wants
                           the voice he knows. google.navigation: is what
                           Google Maps answers to, geo: is what every other
                           maps app answers to, and a phone with neither is
                           told so rather than left with a button that does
                           nothing. Tracking carries on underneath: the
                           foreground service does not know or care what is
                           in front of it. */
                        val intents = viewModel.navigateIntent(stop.latitude!!, stop.longitude!!, stop.name)
                        val opened = intents.any { intent ->
                            runCatching { context.startActivity(intent) }.isSuccess
                        }
                        if (!opened) {
                            BtLog.w("ui", "no navigation app for ${stop.name}")
                            android.widget.Toast.makeText(
                                context, "No maps app on this phone", android.widget.Toast.LENGTH_LONG,
                            ).show()
                        }
                    }
                },
            )

            StopList(stops, counts, trip.direction)

            /* WHO IS ON THE BUS.

               transport_attendance had one writer -- a screen in the office,
               typed up from what the driver remembered -- so it sat empty
               while the product knew the bus's position to the metre. The
               question a parent rings about is not where the bus is; it is
               whether their child is on it, and this is the only place that
               can honestly be answered. */
            ChildrenByStop(
                stops = stops,
                students = students,
                direction = trip.direction,
                pendingMarks = pendingMarks,
                onMark = viewModel::markChild,
                photo = viewModel::photo,
            )

            /* END RUN ASKS FIRST.

               It was a full-width red button directly under a scrolling list,
               and ending a run early tells the school the children are off a
               bus they are still on. A thumb steadying the phone over a
               pothole is enough. The dialog costs a tap at the depot, once. */
            var confirmEnd by remember { mutableStateOf(false) }
            Button(
                onClick = { confirmEnd = true },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(72.dp),
            ) { Text("End Run", style = MaterialTheme.typography.titleMedium) }
            Text(
                "End Run tells the school the children are off the bus. Only you can say that, " +
                    "if the phone simply stops, the school records the run as timed out instead.",
                style = MaterialTheme.typography.bodySmall,
            )

            if (confirmEnd) {
                AlertDialog(
                    onDismissRequest = { confirmEnd = false },
                    title = { Text("End this run?") },
                    text = {
                        Text(
                            "The school will be told the children are off the bus and this " +
                                "phone stops reporting where it is.",
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            confirmEnd = false
                            viewModel.endRun()
                        }) { Text("End the run") }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmEnd = false }) { Text("Keep driving") }
                    },
                )
            }
        }
    }

    // Asked once the driver is looking at the app, never from a service — and
    // in two stages, because that is what the platform requires.
    LocationPermissionPrompt(onFinished = viewModel::refresh)

    /* The settings screen sits over the run rather than replacing it in a
       navigation graph: the run screen's state (scanned bus, half-typed
       password) survives a look at the settings, and the back gesture returns
       to exactly where the driver was. */
    if (settingsOpen) {
        TrackerSettingsScreen(
            status = status,
            busy = busy,
            onClose = { settingsOpen = false },
            onOpen = ::open,
            appSettings = viewModel::openAppSettings,
            locationSettings = viewModel::openLocationSettings,
            batteryExemption = viewModel::requestBatteryExemption,
            notificationSettings = viewModel::openNotificationSettings,
            onStopTracking = viewModel::stopBackgroundTracking,
            onStartTracking = viewModel::startBackgroundTracking,
            onUnpair = viewModel::unpair,
        )
    }

    alert?.let { current ->
        AlertDialog(
            onDismissRequest = viewModel::dismissAlert,
            title = { Text(current.headline) },
            text = { Text(current.detail) },
            confirmButton = {
                val offer = current.supersedeOffer
                if (offer != null) {
                    TextButton(onClick = { viewModel.supersede(offer) }) { Text("Take it over") }
                } else {
                    TextButton(onClick = viewModel::dismissAlert) { Text("OK") }
                }
            },
            dismissButton = {
                // Only an offer to take over another phone's run needs a way
                // out; every other alert is information with one answer.
                if (current.supersedeOffer != null) {
                    TextButton(onClick = viewModel::dismissAlert) { Text("Cancel") }
                }
            },
        )
    }
}

/**
 * Whether the school can see this bus, said once and unmissably.
 *
 * Not reporting was drawn in surfaceVariant -- the same grey as an ordinary
 * card -- so the state that needs somebody to do something looked exactly
 * like the state that does not. It is the error colour now, which is the one
 * thing on this screen that has to be legible from arm's length through a
 * windscreen's worth of glare.
 */
/**
 * Stopping and restarting the reporting itself.
 *
 * Two different sentences depending on whether a run is open, because the
 * consequence is different: with a run open the school loses sight of a moving
 * bus, and the driver has to be told that in those words rather than left to
 * infer it from a stopped service.
 */
@Composable
private fun BackgroundTrackingSwitch(
    running: Boolean,
    runOpen: Boolean,
    onStop: () -> Unit,
    onStart: () -> Unit,
) {
    var confirmStop by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (running) {
            OutlinedButton(
                onClick = { confirmStop = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
            ) { Text("Stop background tracking") }
            Text(
                if (runOpen) {
                    "Stops this phone reporting where it is. The run stays open and the school " +
                        "sees the bus stop moving on their map, so only do this once the bus is parked."
                } else {
                    "Stops this phone reporting where it is. Nothing is running now, so this " +
                        "only shuts down what is left of the tracker."
                },
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            OutlinedButton(
                onClick = onStart,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
            ) { Text("Start background tracking") }
            Text(
                "Tracking is stopped. The school cannot see this bus until this is on again.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text("Stop tracking?") },
            text = {
                Text(
                    if (runOpen) {
                        "The run stays open, but this phone stops sending its position. The " +
                            "school's map will show this bus where it last was."
                    } else {
                        "This phone stops sending its position."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmStop = false
                    onStop()
                }) { Text("Stop tracking") }
            },
            dismissButton = {
                TextButton(onClick = { confirmStop = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ReportingCard(status: TrackerStatus) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (status.reporting) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.errorContainer
            },
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (status.reporting) "The school can see this bus" else "The school cannot see this bus",
                style = MaterialTheme.typography.titleLarge,
            )
            Text(status.summary, style = MaterialTheme.typography.bodyMedium)
            if (status.bufferedFixes > 0) {
                Text(
                    "${status.bufferedFixes} positions are saved on this phone and will be sent " +
                        "when there is signal. Nothing has been lost.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            status.lastServerError?.let {
                Text("Last problem: $it", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/**
 * Where the bus has got to, as one line each.
 *
 * The list was a column of identical body text with a tick or a bullet glued
 * to the front of it, and finding the current position in it meant reading
 * every line. A driver reads this at a stop, in daylight, holding a steering
 * wheel: the three states have to separate at a glance, so done is dimmed,
 * next is the only line in colour, and the rest are plain.
 *
 * The geofence radius is gone from here. It is a number the office sets and
 * the driver can do nothing about, and it was sitting in the same type size
 * as the name of the place they are looking for.
 */
@Composable
private fun StopList(stops: List<StopEntity>, counts: Map<String, Headcount>, direction: String) {
    if (stops.isEmpty()) return
    val nextIndex = stops.indexOfFirst { it.arrivedAtMillis == null }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        stops.forEachIndexed { index, stop ->
            val done = stop.arrivedAtMillis != null
            val isNext = index == nextIndex
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    if (done) "✓" else if (isNext) "▶" else "•",
                    style = MaterialTheme.typography.titleMedium,
                    color = when {
                        done -> MaterialTheme.colorScheme.onSurfaceVariant
                        isNext -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.onSurface
                    },
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        stop.name,
                        style = if (isNext) {
                            MaterialTheme.typography.titleMedium
                        } else {
                            MaterialTheme.typography.bodyLarge
                        },
                        color = when {
                            done -> MaterialTheme.colorScheme.onSurfaceVariant
                            isNext -> MaterialTheme.colorScheme.primary
                            else -> MaterialTheme.colorScheme.onSurface
                        },
                    )
                    counts[stop.stopId]?.let { count ->
                        Text(
                            count.summary(direction),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (done && !count.complete) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
            }
        }
    }
}

/**
 * The next stop, and how much of the run is left.
 *
 * This did not exist. The screen showed the whole list at one weight and the
 * driver worked out where they were by counting ticks, which is a thing done
 * with the bus stationary. The stop being driven towards is the only piece of
 * this screen that changes what the next two minutes look like, so it is the
 * largest thing on it.
 *
 * "Reached X" stays, moved in here beside it: the confirmation that the last
 * geofence registered belongs next to the question it answers, not floating
 * above the sketch as a chip.
 */
@Composable
private fun NextStopCard(
    stops: List<StopEntity>,
    lastArrival: String?,
    counts: Map<String, Headcount> = emptyMap(),
    direction: String = DIRECTION_PICKUP,
    /** Absent when the next stop has no coordinates: nothing to navigate to. */
    onNavigate: (() -> Unit)? = null,
) {
    if (stops.isEmpty()) return
    val done = stops.count { it.arrivedAtMillis != null }
    val next = stops.firstOrNull { it.arrivedAtMillis == null }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (next == null) "All stops done" else "Next stop",
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                next?.name ?: "Take the bus back to school",
                style = MaterialTheme.typography.headlineSmall,
            )
            Text(
                "$done of ${stops.size} stops",
                style = MaterialTheme.typography.bodyMedium,
            )
            /* Who to expect here, before the doors open. "2 of 3 on, 1
               reported absent" is the difference between pulling away and
               waiting for a child who is in bed. */
            next?.let { counts[it.stopId] }?.let { count ->
                Text(
                    if (count.expected == 0 && count.reportedAbsent == 0) {
                        "Nobody allocated to this stop"
                    } else {
                        count.summary(direction)
                    },
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            LinearProgressIndicator(
                progress = { if (stops.isEmpty()) 0f else done.toFloat() / stops.size },
                modifier = Modifier.fillMaxWidth(),
            )
            lastArrival?.let {
                Text("Reached $it", style = MaterialTheme.typography.bodyMedium)
            }
            if (next != null && onNavigate != null) {
                OutlinedButton(
                    onClick = onNavigate,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                ) { Text("Navigate in the maps app") }
            }
        }
    }
}

@Composable
private fun StartRunSection(
    routes: List<SavedRoute>,
    busy: Boolean,
    bus: String,
    onBusScanned: (String) -> Unit,
    onStart: (SavedRoute, String, Boolean) -> Unit,
    onRemoveRoute: (String) -> Unit,
) {
    var direction by remember { mutableStateOf(DIRECTION_PICKUP) }
    // Keyed on the answer: the book starts empty and fills a frame later, so
    // the office-setup form opened for every driver, routes or not.
    var removing by remember { mutableStateOf<SavedRoute?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Start a run", style = MaterialTheme.typography.titleLarge)

        /* WHICH BUS, BEFORE WHICH ROUTE.

           The handset is paired to a bus and the driver may not be in it. He
           reads the sticker in the windscreen — by camera, or by typing the
           code under it when the glass is dirty — and that bus carries this
           run. Empty means the paired one, so a driver who always takes the
           same bus never touches this. */
        val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
            result.contents?.let(onBusScanned)
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedTextField(
                value = bus,
                onValueChange = onBusScanned,
                label = { Text("Bus") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt("Point at the bus sticker")
                            .setBeepEnabled(false)
                            .setOrientationLocked(false)
                            .setCaptureActivity(BusScanActivity::class.java),
                    )
                },
            ) { Text("Scan") }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(DIRECTION_PICKUP to "Pickup", DIRECTION_DROP to "Drop").forEach { (value, label) ->
                if (direction == value) {
                    Button(onClick = { direction = value }) { Text(label) }
                } else {
                    OutlinedButton(onClick = { direction = value }) { Text(label) }
                }
            }
        }

        routes.forEach { route ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = { onStart(route, direction, false) },
                    enabled = !busy,
                    modifier = Modifier
                        .weight(1f)
                        .defaultMinSize(minHeight = 64.dp),
                ) {
                    // A long office label clipped mid-word inside the fixed
                    // height; it wraps to two lines and then ellipsises.
                    Text(
                        "Start Run, ${route.label}",
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                    )
                }
                // Beside a 64dp Start button, a mis-tap deleted the route
                // silently. It asks first.
                TextButton(onClick = { removing = route }, enabled = !busy) { Text("Remove") }
            }
        }

        removing?.let { route ->
            AlertDialog(
                onDismissRequest = { removing = null },
                title = { Text("Remove ${route.label}?") },
                text = { Text("It goes off this phone's list. The office can put it back on.") },
                confirmButton = {
                    TextButton(onClick = {
                        onRemoveRoute(route.routeId)
                        removing = null
                    }) { Text("Remove") }
                },
                dismissButton = {
                    TextButton(onClick = { removing = null }) { Text("Keep it") }
                },
            )
        }

        if (routes.isEmpty()) {
            Text(
                "No route has been put on this bus yet. Ask the office to add one on the " +
                    "Transport screen, then scan the bus again or sign in again and it " +
                    "will be here.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/**
 * Who is driving, and the two words it takes to say so.
 *
 * The server records the driver against every run, which is what a parent is
 * asking when they ask who was on the bus. It gates trip start and end on a
 * session minted from the phone number and PIN the office already issued —
 * the same PIN that signs the driver in to the school's own system, so there
 * is nothing new for anybody to remember.
 *
 * Signing out leaves the phone paired and does not end an open run. A driver
 * who signs out with the bus still moving has made a mistake, and dropping the
 * children off the parents' map is not the way to correct it.
 */
@Composable
private fun DriverSignIn(
    signedIn: Boolean,
    driverName: String?,
    busy: Boolean,
    onSignIn: (String, String) -> Unit,
    onSignOut: () -> Unit,
) {
    if (signedIn) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Driving: ${driverName ?: "signed in"}",
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = onSignOut) { Text("Sign out") }
        }
        return
    }

    var phone by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Sign in to start a run", style = MaterialTheme.typography.titleMedium)
        Text(
            "Your mobile number and the PIN the office gave you. The school records who drove " +
                "each run.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(
            value = phone,
            onValueChange = { phone = it.filter(Char::isDigit).take(10) },
            label = { Text("Mobile number or email") },
            singleLine = true,
            // Email, not Phone. A phone keypad has no @ and no letters, so a
            // driver whose login is an email address could not type it here at
            // all -- and this screen is the only sign-in a handset that was
            // paired before ever shows.
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pin,
            // No longer stripped to digits. This is the ordinary login
            // password now; filtering it silently deleted most of a real one
            // and then reported that it did not match.
            onValueChange = { pin = it.take(72) },
            label = { Text("Password") },
            supportingText = { Text("The same password you use on the school website.") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onSignIn(phone.trim(), pin) },
            // Both non-empty, and no more. The old rule demanded ten digits
            // and four of PIN, which refused every email address before the
            // server ever saw it.
            enabled = !busy && phone.isNotBlank() && pin.isNotEmpty(),
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) { Text("Sign in") }
    }
}


/**
 * The children this run stops for, and one tap each.
 *
 * Collapsed by default. A phone wedged on a dashboard should not be sitting
 * there displaying a list of children's names to everyone who walks past the
 * open door, and the driver only wants it at a stop.
 *
 * Three states, not two. "Absent" is the one that matters most at a stop the
 * bus waited at and nobody came out to: a run with three absents recorded is
 * worth far more to an office at nine o'clock than a run with three blanks,
 * because only one of them tells you somebody should ring a house.
 */
/**
 * The three phone settings that quietly ruin tracking, behind one line.
 *
 * Each of these was a card with a headline and a paragraph, and all three were
 * above the Start button. A driver with notifications off and battery saving
 * on -- which is most phones out of the box -- opened the app to three
 * screenfuls of settings advice and had to scroll past it every morning to
 * reach the two controls he actually wanted.
 *
 * Nothing is hidden that matters: the line says how many need attention, and
 * shows nothing at all when none of them do. What has gone is the assumption
 * that a warning must be the biggest thing on the screen to have been made.
 */
private fun phoneSetupProblems(status: TrackerStatus): List<String> = listOfNotNull(
    status.locationBlocker?.let { "location" },
    if (!status.ignoringBatteryOptimisations) "battery" else null,
    if (!status.notificationsAllowed) "notifications" else null,
)

/** The one line the run screen shows for all of this. */
private fun phoneSetupSummary(status: TrackerStatus): String {
    val problems = phoneSetupProblems(status)
    return if (problems.isEmpty()) "Tracker settings"
    else "${problems.size} phone setting${if (problems.size == 1) "" else "s"} " +
        "could thin out the tracking"
}

/**
 * Full-screen home for everything that is not the run: the phone settings
 * above, the tracker's off switch, and the way back to the sign-in screen.
 *
 * A screen and not a dialog because the content is three explanations with
 * buttons, plus two more below, and a dialog cannot hold that on a handset
 * without scrolling inside a box inside the screen. The back arrow and the
 * back gesture both close it; nothing here changes on the way out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TrackerSettingsScreen(
    status: TrackerStatus,
    busy: Boolean,
    onClose: () -> Unit,
    onOpen: (android.content.Intent) -> Unit,
    appSettings: () -> android.content.Intent,
    locationSettings: () -> android.content.Intent,
    batteryExemption: () -> android.content.Intent,
    notificationSettings: () -> android.content.Intent,
    onStopTracking: () -> Unit,
    onStartTracking: () -> Unit,
    onUnpair: () -> Unit,
) {
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }
    BackHandler(onBack = onClose)

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Tracker settings") },
                // A word, not an arrow glyph: the icon set is not a dependency
                // of this app and a driver reads "Back" faster anyway.
                navigationIcon = {
                    TextButton(onClick = onClose) { Text("Back") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Phone setup", style = MaterialTheme.typography.titleMedium)
            PhoneSetupSection(
                status = status,
                onOpen = onOpen,
                appSettings = appSettings,
                locationSettings = locationSettings,
                batteryExemption = batteryExemption,
                notificationSettings = notificationSettings,
            )

            /* THE OFF SWITCH.

               The tracker is a foreground service whose notification cannot be
               swiped away -- that is what keeps it alive across a four-hour run --
               so the only way to stop it was End Run, which tells the school the
               children are off the bus. A driver parking up at the end of a shift,
               or handing the phone to the office to charge, had the choice between
               saying something untrue and force-stopping the app from Android's
               settings. This is the third answer.

               On this screen, never beside End Run: it is the rarer action
               and must not be reachable by a thumb aiming at End Run. */
            Text("Tracking", style = MaterialTheme.typography.titleMedium)
            BackgroundTrackingSwitch(
                running = status.serviceRunning,
                runOpen = status.trip != null,
                onStop = onStopTracking,
                onStart = onStartTracking,
            )

            /* THE WAY BACK TO THE SIGN-IN SCREEN.

               A handset paired before this build opens straight onto the run
               screen and never shows the number-and-password sign-in at all,
               because that lives behind `paired == false`. The driver is
               looking at a bus that may not be his, with no visible way to
               become himself -- "cannot see the login" is exactly what that
               looks like from the seat.

               Same call as before; the wording is what changed. "Unpair this
               phone" describes the mechanism and reads as something to avoid.
               This says what it is for. */
            Text("Driver", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { confirmUnpair = true }, enabled = !busy) {
                Text(
                    "Sign in as a different driver",
                    textDecoration = TextDecoration.Underline,
                )
            }
            Text(
                "Takes this phone off the bus it is on and asks for your number and " +
                    "password again. Nothing is reported in the meantime.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Take this phone off the bus?") },
            text = {
                Text(
                    "The phone forgets which bus it is and stops reporting. You will " +
                        "sign in again with your number and password.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    onClose()
                    onUnpair()
                }) { Text("Take it off") }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun PhoneSetupSection(
    status: TrackerStatus,
    onOpen: (android.content.Intent) -> Unit,
    appSettings: () -> android.content.Intent,
    locationSettings: () -> android.content.Intent,
    batteryExemption: () -> android.content.Intent,
    notificationSettings: () -> android.content.Intent,
) {
    val problems = phoneSetupProblems(status)
    if (problems.isEmpty()) {
        Text(
            "Location, battery and notifications are all set up for tracking.",
            style = MaterialTheme.typography.bodySmall,
        )
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        status.locationBlocker?.let { blocker ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(blocker.headline, style = MaterialTheme.typography.titleSmall)
                Text(blocker.detail, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { onOpen(appSettings()) }) {
                        Text("App permissions")
                    }
                    OutlinedButton(onClick = { onOpen(locationSettings()) }) {
                        Text("Location settings")
                    }
                }
            }
        }

        if (!status.ignoringBatteryOptimisations) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Battery saving thins out the tracking",
                    style = MaterialTheme.typography.titleSmall)
                Text(
                    "The battery manager slows this app down once the screen has been off " +
                        "a while, and the bus starts jumping across the map instead of moving.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedButton(onClick = { onOpen(batteryExemption()) }) {
                    Text("Allow unrestricted")
                }
            }
        }

        if (!status.notificationsAllowed) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Notifications are switched off",
                    style = MaterialTheme.typography.titleSmall)
                Text(
                    "This app tells you through a notification when the school closes a run " +
                        "or the phone stops reporting. With them off you will not be told.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedButton(onClick = { onOpen(notificationSettings()) }) {
                    Text("Turn notifications on")
                }
            }
        }
    }
}
