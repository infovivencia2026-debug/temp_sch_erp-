package com.schoolerp.bustracker.ui.run

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.ui.LocationPermissionPrompt
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
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
    val alert by viewModel.alert.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val lastArrival by viewModel.lastArrival.collectAsStateWithLifecycle()
    val signedIn by viewModel.signedIn.collectAsStateWithLifecycle()
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            status.vehicleRegistration ?: "Unknown bus",
            style = MaterialTheme.typography.headlineMedium,
        )
        status.institution?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }

        ReportingCard(status)

        status.locationBlocker?.let { blocker ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(blocker.headline, style = MaterialTheme.typography.titleMedium)
                    Text(blocker.detail, style = MaterialTheme.typography.bodyMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { context.startActivity(viewModel.openAppSettings()) }) {
                            Text("App permissions")
                        }
                        OutlinedButton(onClick = { context.startActivity(viewModel.openLocationSettings()) }) {
                            Text("Location settings")
                        }
                    }
                }
            }
        }

        if (!status.ignoringBatteryOptimisations) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Battery saving may thin out the tracking", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "On many phones the battery manager slows this app down when the screen " +
                            "has been off for a while, and the bus starts jumping across the map " +
                            "instead of moving. Allowing it to run unrestricted fixes that.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedButton(onClick = { context.startActivity(viewModel.requestBatteryExemption()) }) {
                        Text("Allow unrestricted")
                    }
                }
            }
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
        if (status.trip == null) {
            DriverSignIn(
                signedIn = signedIn,
                driverName = viewModel.driverName,
                busy = busy,
                onSignIn = viewModel::signIn,
                onSignOut = viewModel::signOut,
            )
        }

        val trip = status.trip
        if (trip == null) {
            StartRunSection(
                routes = routes,
                busy = busy,
                onStart = viewModel::startRun,
                onAddRoute = viewModel::addRoute,
                onRemoveRoute = viewModel::removeRoute,
            )
        } else {
            Text(
                "${trip.routeName.ifBlank { "Route" }} — " +
                    if (trip.direction == DIRECTION_DROP) "drop" else "pickup",
                style = MaterialTheme.typography.titleLarge,
            )
            lastArrival?.let {
                AssistChip(onClick = {}, label = { Text("Reached $it") })
            }
            RouteSketch(stops, modifier = Modifier.fillMaxWidth())
            StopList(stops)

            Button(
                onClick = viewModel::endRun,
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(64.dp),
            ) { Text("End Run") }
            Text(
                "End Run tells the school the children are off the bus. Only you can say that — " +
                    "if the phone simply stops, the school records the run as timed out instead.",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        TextButton(onClick = viewModel::unpair) {
            Text("Unpair this phone", textDecoration = TextDecoration.Underline)
        }
    }

    // Asked once the driver is looking at the app, never from a service — and
    // in two stages, because that is what the platform requires.
    LocationPermissionPrompt(onFinished = viewModel::refresh)

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

@Composable
private fun ReportingCard(status: TrackerStatus) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (status.reporting) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (status.reporting) "The school can see this bus" else "The school cannot see this bus",
                style = MaterialTheme.typography.titleMedium,
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

@Composable
private fun StopList(stops: List<com.schoolerp.bustracker.data.local.StopEntity>) {
    if (stops.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        stops.forEach { stop ->
            Text(
                buildString {
                    append(if (stop.arrivedAtMillis != null) "✓ " else "• ")
                    append(stop.name)
                    if (stop.geofenceM > 0) append("  (${stop.geofenceM} m)")
                },
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun StartRunSection(
    routes: List<SavedRoute>,
    busy: Boolean,
    onStart: (SavedRoute, String, Boolean) -> Unit,
    onAddRoute: (String, String) -> Unit,
    onRemoveRoute: (String) -> Unit,
) {
    var direction by remember { mutableStateOf(DIRECTION_PICKUP) }
    var showAdd by remember { mutableStateOf(routes.isEmpty()) }
    var newId by remember { mutableStateOf("") }
    var newLabel by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Start a run", style = MaterialTheme.typography.titleLarge)

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
                        .height(64.dp),
                ) { Text("Start Run — ${route.label}") }
                TextButton(onClick = { onRemoveRoute(route.routeId) }) { Text("Remove") }
            }
        }

        if (routes.isEmpty()) {
            Text(
                "No routes have been set up on this phone yet. The school's server does not " +
                    "hand the phone a list of routes, so the office has to add each one here " +
                    "once, with its route id. After that you just pick it by name.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        TextButton(onClick = { showAdd = !showAdd }) {
            Text(if (showAdd) "Hide route setup" else "Add a route (office setup)")
        }

        if (showAdd) {
            OutlinedTextField(
                value = newLabel,
                onValueChange = { newLabel = it },
                label = { Text("Name the driver will see") },
                placeholder = { Text("Morning — Anna Nagar") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = newId,
                onValueChange = { newId = it },
                label = { Text("Route id from the transport screen") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    onAddRoute(newId, newLabel)
                    newId = ""
                    newLabel = ""
                    showAdd = false
                },
                enabled = newId.isNotBlank(),
            ) { Text("Save route") }
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
            label = { Text("Mobile number") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pin,
            onValueChange = { pin = it.filter(Char::isDigit).take(6) },
            label = { Text("PIN") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onSignIn(phone, pin) },
            // Ten digits and at least four of PIN: the server's own shape, so
            // an obviously-wrong entry never becomes a failed attempt that
            // counts towards the lockout.
            enabled = !busy && phone.length == 10 && pin.length >= 4,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) { Text("Sign in") }
    }
}
