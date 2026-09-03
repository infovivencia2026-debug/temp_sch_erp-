package com.schoolerp.bustracker.ui.run

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.data.remote.RollChild
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.repo.EndOutcome
import com.schoolerp.bustracker.data.repo.SignInOutcome
import com.schoolerp.bustracker.data.repo.StartOutcome
import com.schoolerp.bustracker.data.repo.TrackerRepository
import com.schoolerp.bustracker.engine.EngineEvent
import com.schoolerp.bustracker.engine.StatusAggregator
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.engine.TripEngine
import com.schoolerp.bustracker.service.TrackerServiceLauncher
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** A message the driver has to acknowledge, shown as a dialog over the run screen. */
data class DriverAlert(
    val headline: String,
    val detail: String,
    /** Set when the only sensible answer is "take the run over from the other phone". */
    val supersedeOffer: PendingStart? = null,
)

data class PendingStart(val routeId: String, val routeName: String, val direction: String)

@HiltViewModel
class RunViewModel @Inject constructor(
    aggregator: StatusAggregator,
    private val repository: TrackerRepository,
    private val settingsStore: SettingsStore,
    private val engine: TripEngine,
    @param:ApplicationContext private val context: Context,
) : ViewModel() {

    val status: StateFlow<TrackerStatus> = aggregator.status
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TrackerStatus())

    @OptIn(ExperimentalCoroutinesApi::class)
    val stops: StateFlow<List<StopEntity>> = repository.settings
        .map { it.activeTrip?.tripId }
        .flatMapLatest { tripId ->
            if (tripId == null) flowOf(emptyList()) else repository.observeStops(tripId)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /* The stored book, which is what a handset still paired to one bus has. */
    private val storedRouteBook: StateFlow<List<SavedRoute>> = repository.settings
        .map { it.routeBook }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /* The lines on the bus whose sticker was just read. Null until a code has
       been entered and the school has answered; empty means the school
       answered and that bus genuinely has no route yet. */
    private val _busRoutes = MutableStateFlow<List<SavedRoute>?>(null)

    /* WHAT THE DRIVER PICKS FROM.

       The scanned bus wins whenever the school has answered for it. Before the
       bus is chosen the handset has nothing to offer but the stored book, and
       falling back to it is what keeps a one-bus driver's morning unchanged. */
    val routeBook: StateFlow<List<SavedRoute>> =
        combine(storedRouteBook, _busRoutes) { stored, scanned -> scanned ?: stored }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _alert = MutableStateFlow<DriverAlert?>(null)
    val alert: StateFlow<DriverAlert?> = _alert.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _lastArrival = MutableStateFlow<String?>(null)
    val lastArrival: StateFlow<String?> = _lastArrival.asStateFlow()

    init {
        viewModelScope.launch {
            engine.events.collect { event ->
                when (event) {
                    is EngineEvent.TripClosedByServer -> _alert.value = DriverAlert(
                        "The school closed this run",
                        "This phone has stopped reporting. If you are still on the route, " +
                            "start the run again.",
                    )
                    is EngineEvent.ClockWrong -> _alert.value = DriverAlert(
                        "This phone's clock is wrong",
                        "The school's server says the time is ${event.serverTime ?: "different"}. " +
                            "Nothing can be recorded until the phone's date and time are corrected.",
                    )
                    /* The token is dead and the pairing has already been
                       cleared by the engine, so this screen is on its way out
                       and the sign-in screen is on its way in. The alert says
                       what happened before that swap, so the driver does not
                       read a sudden login form as the app having crashed. */
                    is EngineEvent.Unpaired -> _alert.value = DriverAlert(
                        "This phone has been signed out",
                        "The school's server no longer accepts it, either the office took this " +
                            "phone off the bus, or you signed in on another handset. It has " +
                            "stopped reporting. Sign in again with your number and password to " +
                            "carry on the run.",
                    )
                    is EngineEvent.StopReached -> _lastArrival.value = event.stopName
                }
            }
        }
    }

    /**
     * Permissions can be revoked from Settings while the app is in the
     * background, so the snapshot is re-read every time this screen resumes
     * rather than only on the engine's timer.
     */
    fun refresh() = engine.refreshDeviceSnapshot()

    fun dismissAlert() {
        _alert.value = null
    }

    /* THE SHIFT, on the screen the driver already has open.
     *
     * Not a separate screen before the run screen: a driver who has already
     * paired should see their routes, and be asked to sign in at the moment it
     * matters, which is when they press Start. Putting a login wall in front
     * of the whole app would also mean a bus that is mid-run shows a login
     * form when the phone is picked up, which is the last thing anybody wants
     * at that moment. */
    val signedIn: StateFlow<Boolean> = repository.signedIn
        .stateIn(viewModelScope, SharingStarted.Eagerly, repository.signedIn.value)

    val driverName: String? get() = repository.driverName()

    fun signIn(phone: String, pin: String) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            when (val outcome = repository.signIn(phone, pin)) {
                is SignInOutcome.SignedIn -> {
                    // Clears the engine's one-way rejection latch. Without
                    // this a driver whose token had been revoked could sign in
                    // successfully and still report nothing, because every
                    // loop returns at that latch and the screen has no way to
                    // know it.
                    engine.credentialAccepted()
                    _alert.value = DriverAlert(
                        "Signed in as ${outcome.name}",
                        "Runs you start will be recorded against your name until you sign out.",
                    )
                }
                is SignInOutcome.Rejected -> _alert.value = DriverAlert(
                    "Could not sign in", outcome.message,
                )
                SignInOutcome.NotPaired -> _alert.value = DriverAlert(
                    "This phone is not paired",
                    "Ask the office for a pairing code before signing in.",
                )
            }
            _busy.value = false
        }
    }

    /* THE REGISTER FOR THE OPEN RUN.

       Empty until the driver opens it: the roll is a list of children's names,
       and a phone on a dashboard should not be showing one until somebody asks
       it to. Refreshed on open rather than polled, because a bus with an
       attendant's second handset would otherwise fight over the same rows. */
    private val _roll = MutableStateFlow<List<RollChild>>(emptyList())
    val roll: StateFlow<List<RollChild>> = _roll.asStateFlow()

    fun refreshRoll() {
        viewModelScope.launch {
            val tripId = repository.settings.first().activeTrip?.tripId ?: return@launch
            repository.roll(tripId)?.let { _roll.value = it }
        }
    }

    /* Marked optimistically, then reconciled.

       A driver at a stop taps three names in four seconds on a connection that
       is a bar of 3G on a bypass. Waiting for each round trip before the tick
       appears is how the fourth child gets marked twice and the fifth not at
       all. The refresh afterwards is what makes the screen honest again if the
       school refused any of them. */
    fun markChild(studentId: String, status: String) {
        _roll.value = _roll.value.map {
            if (it.studentId == studentId) it.copy(status = status) else it
        }
        viewModelScope.launch {
            val tripId = repository.settings.first().activeTrip?.tripId ?: return@launch
            if (!repository.markChild(tripId, studentId, status)) {
                _alert.value = DriverAlert(
                    "That did not reach the school",
                    "The child is still shown as not marked. Try again when you have signal.",
                )
                repository.roll(tripId)?.let { _roll.value = it }
            }
        }
    }

    fun signOut() {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            repository.signOut()
            _busy.value = false
        }
    }

    /** The bus scanned for this run, cleared when the run ends. */
    private val _scannedBus = MutableStateFlow("")
    val scannedBus: StateFlow<String> = _scannedBus.asStateFlow()

    fun onBusScanned(code: String) {
        val trimmed = code.trim()
        _scannedBus.value = trimmed
        /* Ask the school which lines this bus runs, the moment there is enough
           of a code to ask about. Short of that the driver is still typing and
           every keystroke would be a round trip. */
        _busRoutes.value = null
        if (trimmed.length < 4) return
        viewModelScope.launch {
            val fetched = repository.routesForBus(trimmed)
            // Only if the code still stands: a slow answer for a code the
            // driver has since retyped must not fill the list behind them.
            if (fetched != null && _scannedBus.value == trimmed) {
                _busRoutes.value = fetched
            }
        }
    }

    fun clearScannedBus() {
        _scannedBus.value = ""
        _busRoutes.value = null
    }

    fun startRun(route: SavedRoute, direction: String = DIRECTION_PICKUP, supersede: Boolean = false) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            when (val outcome = repository.startTrip(route.routeId, route.label, direction, supersede, _scannedBus.value)) {
                is StartOutcome.Started -> {
                    // The service starts only now. Before this moment there is
                    // no run, and an app collecting location without one would
                    // be following the driver rather than the bus.
                    TrackerServiceLauncher.start(context)
                    if (outcome.stopCount == 0) {
                        _alert.value = DriverAlert(
                            "This route has no stops set up",
                            "The bus will still show on the map, but the school cannot be told " +
                                "which stop it has reached. Mention it to the office.",
                        )
                    }
                }
                is StartOutcome.AlreadyOpen -> _alert.value = DriverAlert(
                    "This bus already has a run open",
                    outcome.message + "\n\nTaking it over closes the other run. Do that only if " +
                        "you are sure the other phone is finished.",
                    supersedeOffer = PendingStart(route.routeId, route.label, direction),
                )
                /* Paired, but nobody has signed in this shift. The server
                   refuses trip start without a driver session and answers 401
                   not_signed_in; the repository catches that before the
                   request, so this can say what to do instead of showing a
                   number. */
                is StartOutcome.NotSignedIn -> _alert.value = DriverAlert(
                    "Sign in before starting the run",
                    "The school records who drove each run, so the phone needs your number and " +
                        "PIN before it can open one. Use Sign in on this screen. The office " +
                        "issued the PIN with your login.",
                )
                is StartOutcome.Failed -> _alert.value = DriverAlert(
                    "Could not start the run",
                    "The school's server refused: ${outcome.reason}. Try again; if it keeps " +
                        "failing, call the office.",
                )
                StartOutcome.NotPaired -> _alert.value = DriverAlert(
                    "This phone is no longer paired",
                    "Ask the office for a new pairing code.",
                )
            }
            _busy.value = false
        }
    }

    fun supersede(pending: PendingStart) {
        _alert.value = null
        startRun(SavedRoute(pending.routeId, pending.routeName), pending.direction, supersede = true)
    }

    fun endRun() {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            when (val outcome = repository.endTrip()) {
                is EndOutcome.Ended -> {
                    TrackerServiceLauncher.stop(context)
                    if (!outcome.reportedToServer) {
                        // The end is owed. The worker settles it when there is
                        // signal, and is asked for now rather than at its next
                        // quarter-hour tick.
                        com.schoolerp.bustracker.service.TripFlushWorker.enqueueOnce(context)
                        _alert.value = DriverAlert(
                            "Run ended, but the school was not told yet",
                            "There was no signal. This phone will tell the school as soon as it " +
                                "has one, and will send " +
                                if (outcome.keptFixes > 0) {
                                    "the ${outcome.keptFixes} positions from the end of the route " +
                                        "with it. Leave the app installed and the phone switched on."
                                } else {
                                    "the end of the run. Leave the app installed and the phone switched on."
                                },
                        )
                    }
                }
                // Only if something is running: a stop intent starts the
                // service just to kill it, and its foreground promotion can
                // raise a false "location permission is missing" alarm.
                EndOutcome.NoTrip -> if (engine.serviceRunning.value) TrackerServiceLauncher.stop(context)
            }
            _busy.value = false
        }
    }

    /* No hand-typed route any more.

       The server sends this bus's routes with every sign-in and every scan,
       and the box that took a route id "from the transport screen" was the
       one place in the app a driver could type a uuid at twenty to seven.
       What it produced was a run filed against a route from a piece of
       paper, which the server then refused as another bus's. */

    fun removeRoute(routeId: String) {
        viewModelScope.launch {
            val remaining = settingsStore.settings.first().routeBook.filterNot { it.routeId == routeId }
            settingsStore.saveRouteBook(remaining)
        }
    }

    /**
     * Stop reporting now, without ending the run.
     *
     * There was no way to do this from the app at all: the service is a
     * foreground service, its notification is not swipeable by design, and the
     * only stop was End Run — which tells the school the children are off the
     * bus. A driver who wanted the phone to stop following him at the end of
     * his shift, or who was handed the phone to charge in the office, had the
     * choice between a lie to the school and force-stopping the app.
     *
     * The run is deliberately left open. Ending it is a statement about
     * children and belongs on the button that says so; this is a statement
     * about the phone. The school sees the bus go stale, which is the truth —
     * nobody is reporting where it is.
     */
    fun stopBackgroundTracking() {
        TrackerServiceLauncher.stop(context)
        engine.refreshDeviceSnapshot()
    }

    /** Start it again without touching the run. */
    fun startBackgroundTracking() {
        TrackerServiceLauncher.start(context)
        engine.refreshDeviceSnapshot()
    }

    fun unpair() {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            repository.unpair()
            TrackerServiceLauncher.stop(context)
            _busy.value = false
        }
    }

    fun openNotificationSettings(): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun openAppSettings(): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun openLocationSettings(): Intent =
        Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * The system dialog that asks, in as many words, whether this app may ignore
     * battery optimisation. Only ever reached from a button the driver pressed,
     * next to an explanation of what it buys.
     */
    @SuppressLint("BatteryLife")
    fun requestBatteryExemption(): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
