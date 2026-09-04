package com.schoolerp.bustracker.ui.run

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomSheetScaffold
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.local.StudentEntity
import com.schoolerp.bustracker.data.prefs.ActiveTrip
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.data.remote.Notice
import com.schoolerp.bustracker.engine.Headcount
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.ui.LocationPermissionPrompt
import com.schoolerp.bustracker.ui.pair.DriverCredentials
import com.schoolerp.bustracker.ui.scan.BusScanActivity
import com.schoolerp.bustracker.ui.theme.BusType
import com.schoolerp.bustracker.ui.theme.ListRow
import com.schoolerp.bustracker.ui.theme.PrimaryButton
import com.schoolerp.bustracker.ui.theme.QuietLink
import com.schoolerp.bustracker.ui.theme.SecondaryButton
import com.schoolerp.bustracker.ui.theme.SectionLabel
import com.schoolerp.bustracker.ui.theme.StatusStrip
import com.schoolerp.bustracker.ui.theme.Tone

/**
 * One screen, three moments: nobody signed in, signed in with no run, and a
 * run open. Each moment has one big button at the bottom -- Sign in, Start
 * run -- or, with a run open, the roster in the driver's thumb and End run
 * deliberately at the far end of the list.
 *
 * Every state, callback and API call is the view model's, unchanged; this
 * file only decides where things sit and how large they are.
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    val arrivedStopId by viewModel.arrivedStopId.collectAsStateWithLifecycle()
    val signedIn by viewModel.signedIn.collectAsStateWithLifecycle()
    val guidance by viewModel.guidance.collectAsStateWithLifecycle()
    val voiceMuted by viewModel.voiceMuted.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var settingsOpen by rememberSaveable { mutableStateOf(false) }

    /* Screen-only drafts, held here so the one button at the bottom of the
       screen can submit what the fields above it hold. */
    var phone by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }
    var emailLogin by rememberSaveable { mutableStateOf(false) }
    var direction by rememberSaveable { mutableStateOf(DIRECTION_PICKUP) }
    var chosenRouteId by rememberSaveable { mutableStateOf<String?>(null) }
    var openedGroup by rememberSaveable { mutableStateOf<String?>(null) }

    // Some ROMs ship without the settings screens these intents name, and an
    // unhandled ActivityNotFoundException took the run screen down with it.
    fun open(intent: Intent) {
        runCatching { context.startActivity(intent) }
            .onFailure { BtLog.w("ui", "no activity for ${intent.action}", it) }
    }

    val trip = status.trip
    val located = stops.filter { it.latitude != null && it.longitude != null }
    val next = stops.firstOrNull { it.arrivedAtMillis == null }
    val counts = trip?.let { t ->
        students.groupBy { it.stopId }.mapValues { (_, here) -> Headcount.of(here, t.direction) }
    } ?: emptyMap()
    // The one route on the phone needs no choosing; a driver who has
    // several picks, and the pick survives rotation.
    val chosenRoute = routes.firstOrNull { it.routeId == chosenRouteId } ?: routes.singleOrNull()
    // The bus moved on: the group the driver folded or opened is forgotten
    // and the next stop opens itself again.
    LaunchedEffect(next?.stopId) { openedGroup = null }

    val noMapsApp = stringResource(R.string.no_maps_app)
    /* The phone's own maps app, for a driver who wants the voice he knows.
       Tracking carries on underneath: the foreground service does not know
       or care what is in front of it. */
    val onNavigate: (() -> Unit)? = next?.takeIf { it.latitude != null && it.longitude != null }?.let { stop ->
        {
            val intents = viewModel.navigateIntent(stop.latitude!!, stop.longitude!!, stop.name)
            val opened = intents.any { intent -> runCatching { context.startActivity(intent) }.isSuccess }
            if (!opened) {
                BtLog.w("ui", "no navigation app for ${stop.name}")
                android.widget.Toast.makeText(context, noMapsApp, android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    val runItems: LazyListScope.(ActiveTrip) -> Unit = { open ->
        runDetails(
            trip = open,
            status = status,
            notices = notices,
            stops = stops,
            students = students,
            counts = counts,
            pendingMarks = pendingMarks,
            lastArrival = lastArrival,
            busy = busy,
            openedGroup = openedGroup,
            onToggleGroup = { id -> openedGroup = if ((openedGroup ?: next?.stopId) == id) "-" else id },
            onNavigate = onNavigate,
            onAcknowledge = viewModel::acknowledgeNotice,
            onMark = viewModel::markChild,
            photo = viewModel::photo,
            onEndRun = viewModel::endRun,
            onSettings = { settingsOpen = true },
        )
    }

    /* THE MAP IS THE SCREEN when there is one to draw: the run's details
       live in a sheet pulled up from the bottom edge, the way a car's
       navigator keeps the trip under the map. The plain list remains for a
       phone with no signal or a route with no coordinates. */
    val mapFillsScreen = trip != null && located.isNotEmpty() && status.hasNetwork

    if (mapFillsScreen && trip != null) {
        val peek = 240.dp
        BottomSheetScaffold(
            sheetPeekHeight = peek,
            sheetContainerColor = MaterialTheme.colorScheme.background,
            sheetContent = {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .fillMaxHeight()
                        .navigationBarsPadding(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) { runItems(trip) }
            },
        ) { inner ->
            RouteMap(
                stops = stops,
                guidance = guidance,
                muted = voiceMuted,
                onMuteChange = viewModel::setVoiceMuted,
                fillScreen = true,
                controlsBottomPadding = peek,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(inner),
            )
        }
    } else {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = MaterialTheme.colorScheme.background,
            bottomBar = {
                if (trip == null) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.background)
                            .imePadding()
                            .padding(horizontal = 20.dp)
                            .padding(bottom = 16.dp),
                    ) {
                        if (!signedIn) {
                            PrimaryButton(
                                text = stringResource(R.string.signin_button),
                                onClick = { viewModel.signIn(phone.trim(), pin) },
                                enabled = phone.isNotBlank() && pin.isNotEmpty(),
                                busy = busy,
                            )
                        } else {
                            PrimaryButton(
                                text = stringResource(R.string.start_run),
                                onClick = { chosenRoute?.let { viewModel.startRun(it, direction, false) } },
                                enabled = chosenRoute != null,
                                busy = busy,
                            )
                        }
                    }
                }
            },
        ) { padding ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (trip == null) {
                    item(key = "status") { StatusCard(status) }
                    if (notices.isNotEmpty()) {
                        item(key = "notice") { NoticeCard(notices, onAcknowledge = viewModel::acknowledgeNotice) }
                    }
                    if (!signedIn) {
                        item(key = "signin") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(stringResource(R.string.signin_intro), style = BusType.display)
                                Text(
                                    stringResource(R.string.signin_who),
                                    style = BusType.small,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                DriverCredentials(
                                    phone = phone,
                                    onPhoneChanged = { phone = it.take(120) },
                                    pin = pin,
                                    onPinChanged = { pin = it.take(72) },
                                    emailLogin = emailLogin,
                                    onEmailLoginChanged = { emailLogin = it },
                                    onDone = { if (phone.isNotBlank() && pin.isNotEmpty()) viewModel.signIn(phone.trim(), pin) },
                                )
                            }
                        }
                    } else {
                        startRunItems(
                            driverName = viewModel.driverName,
                            routes = routes,
                            chosenRoute = chosenRoute,
                            direction = direction,
                            bus = scannedBus,
                            busy = busy,
                            onChooseRoute = { chosenRouteId = it.routeId },
                            onDirection = { direction = it },
                            onBusScanned = viewModel::onBusScanned,
                            onRemoveRoute = viewModel::removeRoute,
                            onSignOut = viewModel::signOut,
                        )
                    }
                    item(key = "settings-link") { SettingsLink(status) { settingsOpen = true } }
                } else {
                    /* THE RUN WITHOUT A MAP: no signal, or a route with no
                       coordinates. The sketch draws the stops to scale and the
                       banner still says where to turn. */
                    if (located.isNotEmpty() && next != null) {
                        item(key = "banner") {
                            NavigationBanner(
                                guidance = guidance,
                                muted = voiceMuted,
                                onMuteChange = viewModel::setVoiceMuted,
                            )
                        }
                    }
                    item(key = "sketch") { RouteSketch(stops, modifier = Modifier.fillMaxWidth()) }
                    runItems(trip)
                }
            }
        }
    }

    /* THE DOORS OPEN: the geofence fired, and that stop's children are put
       in front of the driver until Done. A stop with nobody allocated raises
       nothing: there is nobody to mark. */
    val arrivedStop = arrivedStopId?.let { id -> stops.firstOrNull { it.stopId == id } }
    val arrivedChildren = arrivedStop?.let { stop -> students.filter { it.stopId == stop.stopId } } ?: emptyList()
    if (trip != null && arrivedStop != null && arrivedChildren.isNotEmpty()) {
        StopArrivalSheet(
            stopName = arrivedStop.name,
            students = arrivedChildren,
            direction = trip.direction,
            onMark = viewModel::markChild,
            photo = viewModel::photo,
            onDone = viewModel::dismissArrival,
        )
    } else if (arrivedStopId != null) {
        LaunchedEffect(arrivedStopId) { viewModel.dismissArrival() }
    }
    // Asked once the driver is looking at the app, never from a service — and
    // in two stages, because that is what the platform requires.
    LocationPermissionPrompt(onFinished = viewModel::refresh)

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
            title = { Text(current.headline, style = BusType.display) },
            text = { Text(current.detail, style = BusType.body) },
            confirmButton = {
                val offer = current.supersedeOffer
                if (offer != null) {
                    Button(onClick = { viewModel.supersede(offer) }) {
                        Text(stringResource(R.string.take_over), style = BusType.bodyStrong)
                    }
                } else {
                    Button(onClick = viewModel::dismissAlert) {
                        Text(stringResource(R.string.action_ok), style = BusType.bodyStrong)
                    }
                }
            },
            dismissButton = {
                // Only an offer to take over another phone's run needs a way
                // out; every other alert is information with one answer.
                if (current.supersedeOffer != null) {
                    TextButton(onClick = viewModel::dismissAlert) {
                        Text(stringResource(R.string.action_cancel), style = BusType.small)
                    }
                }
            },
        )
    }
}

/* ------------------------------------------------------------- status */

/**
 * The status, in a word the driver reads at a glance, and the sentence
 * under it. One calm tint for tracking, one warning tint for anything that
 * leaves the school unable to see the bus, plain grey for "no run open".
 */
@Composable
private fun StatusCard(status: TrackerStatus) {
    val (headline, tone) = when {
        status.locationBlocker != null -> R.string.status_location_off to Tone.PROBLEM
        status.trip == null -> R.string.status_no_run to Tone.PLAIN
        status.pausedByServer -> R.string.status_paused to Tone.PROBLEM
        !status.serviceRunning -> R.string.status_stopped to Tone.PROBLEM
        !status.hasNetwork -> R.string.status_no_signal to Tone.PROBLEM
        status.behind -> R.string.status_behind to Tone.PROBLEM
        else -> R.string.status_tracking to Tone.CALM
    }
    val scheme = MaterialTheme.colorScheme
    val ink = when (tone) {
        Tone.CALM -> scheme.onPrimaryContainer
        Tone.PROBLEM -> scheme.onErrorContainer
        Tone.PLAIN -> scheme.onSurfaceVariant
    }
    StatusStrip(
        headline = stringResource(headline),
        tone = tone,
        detail = if (status.trip == null) {
            null
        } else if (status.reporting) {
            stringResource(R.string.school_can_see)
        } else {
            stringResource(R.string.school_cannot_see)
        },
    ) {
        if (status.trip != null) {
            // The engine's own one-liner, the same words as the notification.
            Text(status.summary, style = BusType.small, color = ink)
        }
        if (status.bufferedFixes > 0) {
            Text(stringResource(R.string.status_saved_fixes, status.bufferedFixes), style = BusType.small, color = ink)
        }
        status.lastServerError?.let {
            Text(stringResource(R.string.status_last_problem, it), style = BusType.small, color = ink)
        }
    }
}

/* -------------------------------------------------------- before a run */

/**
 * Signed in: who is driving, which bus, which way, which route. The route
 * rows are the choice; the big Start run button lives in the bottom bar.
 */
private fun LazyListScope.startRunItems(
    driverName: String?,
    routes: List<SavedRoute>,
    chosenRoute: SavedRoute?,
    direction: String,
    bus: String,
    busy: Boolean,
    onChooseRoute: (SavedRoute) -> Unit,
    onDirection: (String) -> Unit,
    onBusScanned: (String) -> Unit,
    onRemoveRoute: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    item(key = "driver") {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.driving_as, driverName ?: ""),
                style = BusType.small,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            QuietLink(text = stringResource(R.string.sign_out), onClick = onSignOut, enabled = !busy)
        }
    }
    item(key = "start-title") { Text(stringResource(R.string.start_title), style = BusType.display) }

    /* WHICH BUS, BEFORE WHICH ROUTE. Empty means the paired one, so a driver
       who always takes the same bus never touches this. */
    item(key = "bus") {
        val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
            result.contents?.let(onBusScanned)
        }
        val scanPrompt = stringResource(R.string.bus_scan_prompt)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel(stringResource(R.string.bus_label))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedTextField(
                    value = bus,
                    onValueChange = onBusScanned,
                    placeholder = {
                        Text(
                            stringResource(R.string.bus_default),
                            style = BusType.small,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    singleLine = true,
                    textStyle = BusType.body,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = stringResource(R.string.bus_scan),
                    onClick = {
                        scanner.launch(
                            ScanOptions()
                                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                .setPrompt(scanPrompt)
                                .setBeepEnabled(false)
                                .setOrientationLocked(false)
                                .setCaptureActivity(BusScanActivity::class.java),
                        )
                    },
                )
            }
        }
    }

    item(key = "direction") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            listOf(DIRECTION_PICKUP to R.string.direction_pickup, DIRECTION_DROP to R.string.direction_drop)
                .forEach { (value, label) ->
                    if (direction == value) {
                        Button(
                            onClick = { onDirection(value) },
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier
                                .weight(1f)
                                .height(56.dp),
                        ) { Text(stringResource(label), style = BusType.bodyStrong) }
                    } else {
                        SecondaryButton(
                            text = stringResource(label),
                            onClick = { onDirection(value) },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
        }
    }

    item(key = "route-label") { SectionLabel(stringResource(R.string.route_pick)) }
    if (routes.isEmpty()) {
        item(key = "route-none") {
            Text(
                stringResource(R.string.route_none),
                style = BusType.body,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    items(routes, key = { "route-${it.routeId}" }) { route ->
        var removing by rememberSaveable { mutableStateOf(false) }
        ListRow(
            title = route.label,
            selected = route.routeId == chosenRoute?.routeId,
            enabled = !busy,
            onClick = { onChooseRoute(route) },
            trailing = {
                // Small and at the far side from the Start button: a mis-tap
                // here asks before it deletes anything.
                QuietLink(text = stringResource(R.string.route_remove), onClick = { removing = true }, enabled = !busy)
            },
        )
        if (removing) {
            AlertDialog(
                onDismissRequest = { removing = false },
                title = { Text(stringResource(R.string.route_remove_title, route.label), style = BusType.display) },
                text = { Text(stringResource(R.string.route_remove_body), style = BusType.body) },
                confirmButton = {
                    TextButton(onClick = {
                        onRemoveRoute(route.routeId)
                        removing = false
                    }) { Text(stringResource(R.string.route_remove), style = BusType.bodyStrong) }
                },
                dismissButton = {
                    Button(onClick = { removing = false }) {
                        Text(stringResource(R.string.route_keep), style = BusType.bodyStrong)
                    }
                },
            )
        }
    }
}

/* ---------------------------------------------------------- during a run */

/**
 * Everything about the open run except the map: the office's message, the
 * status, the next stop, the roster under sticky stop headings, and End run
 * at the far end where a thumb steadying the phone cannot reach it by
 * accident. One list so the sheet under the map and the column without one
 * show the same thing in the same order.
 */
private fun LazyListScope.runDetails(
    trip: ActiveTrip,
    status: TrackerStatus,
    notices: List<Notice>,
    stops: List<StopEntity>,
    students: List<StudentEntity>,
    counts: Map<String, Headcount>,
    pendingMarks: Int,
    lastArrival: String?,
    busy: Boolean,
    openedGroup: String?,
    onToggleGroup: (String) -> Unit,
    onNavigate: (() -> Unit)?,
    onAcknowledge: (String) -> Unit,
    onMark: (String, String) -> Unit,
    photo: suspend (String) -> android.graphics.Bitmap?,
    onEndRun: () -> Unit,
    onSettings: () -> Unit,
) {
    if (notices.isNotEmpty()) item(key = "notice") { NoticeCard(notices, onAcknowledge = onAcknowledge) }
    item(key = "heading") {
        Text(
            stringResource(
                R.string.run_heading,
                trip.routeName.ifBlank { stringResource(R.string.route_fallback) },
                stringResource(if (trip.direction == DIRECTION_DROP) R.string.direction_drop else R.string.direction_pickup),
            ),
            style = BusType.display,
        )
    }
    item(key = "status") { StatusCard(status) }
    item(key = "next-stop") { NextStopCard(stops, lastArrival, counts, trip.direction, onNavigate) }

    rosterItems(
        stops = stops,
        students = students,
        direction = trip.direction,
        pendingMarks = pendingMarks,
        opened = openedGroup,
        onToggleGroup = onToggleGroup,
        onMark = onMark,
        photo = photo,
    )

    /* END RUN ASKS FIRST. Ending a run early tells the school the children
       are off a bus they are still on. The dialog costs a tap at the depot,
       once. */
    item(key = "end-run") {
        var confirmEnd by rememberSaveable { mutableStateOf(false) }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 16.dp)) {
            PrimaryButton(
                text = stringResource(R.string.end_run),
                onClick = { confirmEnd = true },
                enabled = !busy,
                warning = true,
            )
            Text(
                stringResource(R.string.end_run_note),
                style = BusType.small,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (confirmEnd) {
            AlertDialog(
                onDismissRequest = { confirmEnd = false },
                title = { Text(stringResource(R.string.end_run_title), style = BusType.display) },
                text = { Text(stringResource(R.string.end_run_body), style = BusType.body) },
                confirmButton = {
                    TextButton(onClick = {
                        confirmEnd = false
                        onEndRun()
                    }) { Text(stringResource(R.string.end_run_confirm), style = BusType.bodyStrong) }
                },
                dismissButton = {
                    Button(onClick = { confirmEnd = false }) {
                        Text(stringResource(R.string.end_run_keep), style = BusType.bodyStrong)
                    }
                },
            )
        }
    }
    item(key = "settings-link") { SettingsLink(status, onSettings) }
}

/**
 * The next stop, and how much of the run is left: the one line read at a
 * junction, so it is in the largest type and first after the status.
 */
@Composable
private fun NextStopCard(
    stops: List<StopEntity>,
    lastArrival: String?,
    counts: Map<String, Headcount>,
    direction: String,
    onNavigate: (() -> Unit)?,
) {
    if (stops.isEmpty()) return
    val done = stops.count { it.arrivedAtMillis != null }
    val next = stops.firstOrNull { it.arrivedAtMillis == null }
    val scheme = MaterialTheme.colorScheme

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(scheme.surfaceVariant)
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            stringResource(if (next == null) R.string.all_stops_done else R.string.next_stop),
            style = BusType.small,
            color = scheme.onSurfaceVariant,
        )
        Text(next?.name ?: stringResource(R.string.back_to_school), style = BusType.display, color = scheme.onSurface)
        Text(
            stringResource(R.string.stops_progress, done, stops.size),
            style = BusType.small,
            color = scheme.onSurfaceVariant,
        )
        /* Who to expect here, before the doors open: the difference between
           pulling away and waiting for a child who is in bed. */
        next?.let { counts[it.stopId] }?.let { count ->
            Text(
                if (count.expected == 0 && count.reportedAbsent == 0) {
                    stringResource(R.string.nobody_at_stop)
                } else {
                    headcountText(count, direction)
                },
                style = BusType.body,
                color = scheme.onSurface,
            )
        }
        LinearProgressIndicator(
            progress = { if (stops.isEmpty()) 0f else done.toFloat() / stops.size },
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
        )
        lastArrival?.let {
            Text(stringResource(R.string.reached, it), style = BusType.small, color = scheme.onSurfaceVariant)
        }
        if (next != null && onNavigate != null) {
            SecondaryButton(
                text = stringResource(R.string.navigate_maps),
                onClick = onNavigate,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/* -------------------------------------------------------------- settings */

private fun phoneSetupProblems(status: TrackerStatus): Int = listOfNotNull(
    status.locationBlocker,
    if (!status.ignoringBatteryOptimisations) "battery" else null,
    if (!status.notificationsAllowed) "notifications" else null,
).size

/** One quiet line to the settings screen; it says so when something there needs attention. */
@Composable
private fun SettingsLink(status: TrackerStatus, onSettings: () -> Unit) {
    val problems = phoneSetupProblems(status)
    val text = when (problems) {
        0 -> stringResource(R.string.settings_line)
        1 -> stringResource(R.string.settings_problem_one)
        else -> stringResource(R.string.settings_problem_many, problems)
    }
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (problems > 0) {
            Text(text, style = BusType.small, color = MaterialTheme.colorScheme.error)
            QuietLink(text = stringResource(R.string.settings_line), onClick = onSettings)
        } else {
            QuietLink(text = text, onClick = onSettings)
        }
    }
}

/**
 * Full-screen home for everything that is not the run: the phone settings
 * that quietly ruin tracking, the tracker's off switch, and the way back to
 * the sign-in screen. The back arrow and the back gesture both close it;
 * nothing here changes on the way out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TrackerSettingsScreen(
    status: TrackerStatus,
    busy: Boolean,
    onClose: () -> Unit,
    onOpen: (Intent) -> Unit,
    appSettings: () -> Intent,
    locationSettings: () -> Intent,
    batteryExemption: () -> Intent,
    notificationSettings: () -> Intent,
    onStopTracking: () -> Unit,
    onStartTracking: () -> Unit,
    onUnpair: () -> Unit,
) {
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }
    var confirmStop by rememberSaveable { mutableStateOf(false) }
    BackHandler(onBack = onClose)
    val runOpen = status.trip != null

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title), style = BusType.display) },
                // A word, not an arrow glyph: a driver reads "Back" faster.
                navigationIcon = {
                    TextButton(onClick = onClose) { Text(stringResource(R.string.action_back), style = BusType.bodyStrong) }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionLabel(stringResource(R.string.phone_setup))
            PhoneSetupSection(
                status = status,
                onOpen = onOpen,
                appSettings = appSettings,
                locationSettings = locationSettings,
                batteryExemption = batteryExemption,
                notificationSettings = notificationSettings,
            )

            /* THE OFF SWITCH. On this screen, never beside End run: it is the
               rarer action and must not be reachable by a thumb aiming at
               End run. */
            SectionLabel(stringResource(R.string.tracking_section))
            if (status.serviceRunning) {
                SecondaryButton(
                    text = stringResource(R.string.tracking_stop),
                    onClick = { confirmStop = true },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    stringResource(if (runOpen) R.string.tracking_stop_note_run else R.string.tracking_stop_note_idle),
                    style = BusType.small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                SecondaryButton(
                    text = stringResource(R.string.tracking_start),
                    onClick = onStartTracking,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    stringResource(R.string.tracking_stopped_note),
                    style = BusType.small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            /* THE WAY BACK TO THE SIGN-IN SCREEN. */
            SectionLabel(stringResource(R.string.driver_section))
            QuietLink(text = stringResource(R.string.change_driver), onClick = { confirmUnpair = true }, enabled = !busy)
            Text(
                stringResource(R.string.change_driver_note),
                style = BusType.small,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text(stringResource(R.string.tracking_stop_title), style = BusType.display) },
            text = {
                Text(
                    stringResource(if (runOpen) R.string.tracking_stop_body_run else R.string.tracking_stop_body_idle),
                    style = BusType.body,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmStop = false
                    onStopTracking()
                }) { Text(stringResource(R.string.tracking_stop), style = BusType.bodyStrong) }
            },
            dismissButton = {
                Button(onClick = { confirmStop = false }) {
                    Text(stringResource(R.string.action_cancel), style = BusType.bodyStrong)
                }
            },
        )
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(stringResource(R.string.unpair_title), style = BusType.display) },
            text = { Text(stringResource(R.string.unpair_body), style = BusType.body) },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    onClose()
                    onUnpair()
                }) { Text(stringResource(R.string.unpair_confirm), style = BusType.bodyStrong) }
            },
            dismissButton = {
                Button(onClick = { confirmUnpair = false }) {
                    Text(stringResource(R.string.action_cancel), style = BusType.bodyStrong)
                }
            },
        )
    }
}

@Composable
private fun PhoneSetupSection(
    status: TrackerStatus,
    onOpen: (Intent) -> Unit,
    appSettings: () -> Intent,
    locationSettings: () -> Intent,
    batteryExemption: () -> Intent,
    notificationSettings: () -> Intent,
) {
    if (phoneSetupProblems(status) == 0) {
        Text(
            stringResource(R.string.phone_setup_ok),
            style = BusType.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        status.locationBlocker?.let { blocker ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(blocker.headline, style = BusType.bodyStrong, color = MaterialTheme.colorScheme.error)
                Text(blocker.detail, style = BusType.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SecondaryButton(
                    text = stringResource(R.string.app_permissions),
                    onClick = { onOpen(appSettings()) },
                    modifier = Modifier.fillMaxWidth(),
                )
                SecondaryButton(
                    text = stringResource(R.string.location_settings),
                    onClick = { onOpen(locationSettings()) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (!status.ignoringBatteryOptimisations) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.battery_title), style = BusType.bodyStrong)
                Text(
                    stringResource(R.string.battery_body),
                    style = BusType.small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SecondaryButton(
                    text = stringResource(R.string.battery_button),
                    onClick = { onOpen(batteryExemption()) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (!status.notificationsAllowed) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.notif_title), style = BusType.bodyStrong)
                Text(
                    stringResource(R.string.notif_body),
                    style = BusType.small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SecondaryButton(
                    text = stringResource(R.string.notif_button),
                    onClick = { onOpen(notificationSettings()) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
