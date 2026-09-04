package com.schoolerp.bustracker.ui.run

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.graphics.Bitmap
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.local.StudentEntity
import com.schoolerp.bustracker.data.remote.Notice
import com.schoolerp.bustracker.data.remote.OsrmApi
import com.schoolerp.bustracker.device.Fix
import com.schoolerp.bustracker.navigation.Guidance
import com.schoolerp.bustracker.navigation.LatLng
import com.schoolerp.bustracker.navigation.Navigator
import com.schoolerp.bustracker.navigation.RoutePlan
import com.schoolerp.bustracker.navigation.VoiceGuide
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.data.repo.PhotoStore
import kotlinx.coroutines.flow.distinctUntilChanged
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
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
    private val photos: PhotoStore,
    @param:ApplicationContext private val context: Context,
    private val osrm: OsrmApi,
    private val voice: VoiceGuide,
) : ViewModel() {

    private fun str(id: Int): String = context.getString(id)

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

    /* THE STOP THE DOORS JUST OPENED AT.

       Set by the geofence and cleared by the driver's Done, so the screen can
       put that stop's children in front of him while they are getting on.
       Held separately from lastArrival, which is a line of text that stays
       until the next stop; this is a sheet that has to go away when told. */
    private val _arrivedStopId = MutableStateFlow<String?>(null)
    val arrivedStopId: StateFlow<String?> = _arrivedStopId.asStateFlow()

    fun dismissArrival() {
        _arrivedStopId.value = null
    }

    /* THE BUS ON THE MAP, from the engine's own fix. Not a second location
       client: see TripEngine.lastFix. */
    val lastFix: StateFlow<Fix?> = engine.lastFix

    /* WHERE TO GO NEXT.

       The run screen drew the stops to scale on a blank canvas and called it
       a sketch, which was honest and useless: a driver put on a new route
       could see that the next stop was north-east of him and nothing about
       how to get there. This is the plan through the remaining stops, from
       the router, and the guidance read off it for every fix.

       The plan is fetched once per situation and kept: once when the run's
       next stop changes (a stop was reached, so the leg in front is a new
       one), and again if the bus wanders more than 150 m off the line -- a
       diversion, or a driver who knows a better road. Never per fix and
       never per recomposition; the public router would refuse that within a
       minute and a self-hosted one should not have to carry it. */
    private data class Planned(val key: PlanKey, val plan: RoutePlan?, val stamp: Long)

    private data class PlanKey(val fromBus: Boolean, val remaining: List<String>)

    private val planned = MutableStateFlow<Planned?>(null)
    private var planning = false
    private var lastPlanAtMillis = 0L

    /* This fix and the one before it, so a heading can be worked out on a
       phone whose GPS reports no bearing. */
    private val fixPair = MutableStateFlow<Pair<Fix?, Fix?>>(null to null)

    val guidance: StateFlow<Guidance?> = combine(stops, fixPair, planned) { stops, (previous, fix), planned ->
        val next = stops.firstOrNull { it.arrivedAtMillis == null } ?: return@combine null
        val plan = planned?.plan ?: return@combine null
        Navigator.guide(
            plan = plan,
            bus = fix?.let { LatLng(it.latitude, it.longitude) },
            fixHeadingDeg = fix?.headingDeg?.toDouble(),
            previousBus = previous?.let { LatLng(it.latitude, it.longitude) },
            nextStopName = next.name,
            nextStop = next.latitude?.let { lat -> next.longitude?.let { LatLng(lat, it) } },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val voiceMuted: StateFlow<Boolean> = repository.settings
        .map { it.voiceMuted }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    fun setVoiceMuted(muted: Boolean) {
        viewModelScope.launch { settingsStore.setVoiceMuted(muted) }
    }

    private fun watchRoute() {
        viewModelScope.launch {
            engine.lastFix.collect { fix -> fixPair.value = fixPair.value.second to fix }
        }
        viewModelScope.launch {
            combine(stops, engine.lastFix) { stops, fix -> stops to fix }.collect { (stops, fix) ->
                val remaining = stops.filter { it.arrivedAtMillis == null && it.latitude != null && it.longitude != null }
                if (remaining.isEmpty()) {
                    planned.value = null
                    return@collect
                }
                val key = PlanKey(fromBus = fix != null, remaining = remaining.map { it.stopId })
                val current = planned.value
                val now = System.currentTimeMillis()
                val offRoute = current?.plan != null && fix != null &&
                    Navigator.project(current.plan, LatLng(fix.latitude, fix.longitude)).offM > Navigator.OFF_ROUTE_M
                val stale = current == null || current.key != key ||
                    (offRoute && now - lastPlanAtMillis > REPLAN_NO_SOONER_THAN_MILLIS)
                if (!stale || planning) return@collect

                planning = true
                lastPlanAtMillis = now
                val through = listOfNotNull(fix?.let { LatLng(it.latitude, it.longitude) }) +
                    remaining.map { LatLng(it.latitude!!, it.longitude!!) }
                // Asked of the router; straight lines between the stops if it
                // does not answer. Either way the driver has a line to follow.
                val plan = osrm.route(through)?.let(RoutePlan::fromOsrm) ?: RoutePlan.straight(through)
                BtLog.i("nav", "planned ${through.size} points, roads=${plan?.roadFollowing}")
                planned.value = Planned(key, plan, now)
                planning = false
            }
        }
        /* Each instruction is spoken once per band and never again for the
           same manoeuvre, however many fixes land inside that band. A new
           plan resets that, which on a diversion is what the driver wants. */
        viewModelScope.launch {
            val spoken = HashSet<String>()
            var lastStamp = 0L
            combine(guidance, voiceMuted, planned) { g, muted, p -> Triple(g, muted, p?.stamp ?: 0L) }
                .collect { (g, muted, stamp) ->
                    if (stamp != lastStamp) {
                        spoken.clear()
                        lastStamp = stamp
                    }
                    val cue = g?.cue ?: return@collect
                    val key = if (cue.stepIndex == Int.MAX_VALUE) "arrive:${g.nextStopName}" else "${cue.stepIndex}:${cue.band}"
                    if (spoken.add(key) && !muted) voice.say(cue.text)
                }
        }
    }

    /**
     * Turn-by-turn in whatever maps app the phone has, for a driver who wants
     * the one he knows. The service keeps reporting underneath it: this is an
     * activity in front, not a change to the run.
     */
    fun navigateIntent(latitude: Double, longitude: Double, name: String): List<Intent> = listOf(
        Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$latitude,$longitude&mode=d")),
        Intent(
            Intent.ACTION_VIEW,
            Uri.parse("geo:$latitude,$longitude?q=$latitude,$longitude(${Uri.encode(name)})"),
        ),
    ).map { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }

    init {
        watchRoute()
        viewModelScope.launch {
            engine.events.collect { event ->
                when (event) {
                    is EngineEvent.TripClosedByServer -> _alert.value = DriverAlert(
                        str(R.string.alert_closed_title),
                        str(R.string.alert_closed_body),
                    )
                    is EngineEvent.ClockWrong -> _alert.value = DriverAlert(
                        str(R.string.alert_clock_title),
                        context.getString(
                            R.string.alert_clock_body,
                            event.serverTime ?: str(R.string.alert_clock_different),
                        ),
                    )
                    /* The token is dead and the pairing has already been
                       cleared by the engine, so this screen is on its way out
                       and the sign-in screen is on its way in. The alert says
                       what happened before that swap, so the driver does not
                       read a sudden login form as the app having crashed. */
                    is EngineEvent.Unpaired -> _alert.value = DriverAlert(
                        str(R.string.alert_signed_out_title),
                        str(R.string.alert_signed_out_body),
                    )
                    is EngineEvent.StopReached -> {
                        _lastArrival.value = event.stopName
                        _arrivedStopId.value = event.stopId
                    }
                    // Shown as a banner from the notices flow; nothing to do here.
                    is EngineEvent.Notice -> Unit
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
                        context.getString(R.string.alert_signed_in_title, outcome.name),
                        str(R.string.alert_signed_in_body),
                    )
                }
                is SignInOutcome.Rejected -> _alert.value = DriverAlert(
                    str(R.string.alert_cannot_signin), outcome.message,
                )
                SignInOutcome.NotPaired -> _alert.value = DriverAlert(
                    str(R.string.alert_not_paired_title),
                    str(R.string.alert_not_paired_body),
                )
            }
            _busy.value = false
        }
    }

    /* WHO IS ON THE BUS, from disk.

       Observed, not fetched: the roster is written by the repository when the
       run starts and on every heartbeat, and the driver's taps land in the
       same table. The screen never waits on the school to draw a name. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val students: StateFlow<List<StudentEntity>> = repository.settings
        .map { it.activeTrip?.tripId }
        .distinctUntilChanged()
        .flatMapLatest { tripId ->
            if (tripId == null) flowOf(emptyList()) else repository.observeStudents(tripId)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val pendingMarks: StateFlow<Int> = repository.pendingMarks
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

    fun markChild(studentId: String, status: String) {
        viewModelScope.launch {
            val tripId = repository.settings.first().activeTrip?.tripId ?: return@launch
            repository.markBoarding(tripId, studentId, status)
        }
    }

    suspend fun photo(studentId: String): Bitmap? = photos.load(studentId)

    /* THE OFFICE'S MESSAGES, with one button. */
    val notices: StateFlow<List<Notice>> = repository.notices

    fun acknowledgeNotice(noticeId: String) {
        viewModelScope.launch { repository.acknowledgeNotice(noticeId) }
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
                            str(R.string.alert_no_stops_title),
                            str(R.string.alert_no_stops_body),
                        )
                    }
                }
                is StartOutcome.AlreadyOpen -> _alert.value = DriverAlert(
                    str(R.string.alert_already_open_title),
                    context.getString(R.string.alert_already_open_body, outcome.message),
                    supersedeOffer = PendingStart(route.routeId, route.label, direction),
                )
                /* Paired, but nobody has signed in this shift. The server
                   refuses trip start without a driver session and answers 401
                   not_signed_in; the repository catches that before the
                   request, so this can say what to do instead of showing a
                   number. */
                is StartOutcome.NotSignedIn -> _alert.value = DriverAlert(
                    str(R.string.alert_sign_in_first_title),
                    str(R.string.alert_sign_in_first_body),
                )
                is StartOutcome.Failed -> _alert.value = DriverAlert(
                    str(R.string.alert_start_failed_title),
                    context.getString(R.string.alert_start_failed_body, outcome.reason),
                )
                StartOutcome.NotPaired -> _alert.value = DriverAlert(
                    str(R.string.alert_no_longer_paired_title),
                    str(R.string.alert_no_longer_paired_body),
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
                            str(R.string.alert_end_offline_title),
                            if (outcome.keptFixes > 0) {
                                context.getString(R.string.alert_end_offline_fixes, outcome.keptFixes)
                            } else {
                                str(R.string.alert_end_offline_body)
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

    private companion object {
        /** Off-route replans no closer together than this: the router is shared. */
        const val REPLAN_NO_SOONER_THAN_MILLIS = 20_000L
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
