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
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.repo.EndOutcome
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

    val routeBook: StateFlow<List<SavedRoute>> = repository.settings
        .map { it.routeBook }
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
                    is EngineEvent.Unpaired -> _alert.value = DriverAlert(
                        "This phone is no longer paired",
                        "The school's server rejected it. Ask the office for a new pairing code.",
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

    fun startRun(route: SavedRoute, direction: String = DIRECTION_PICKUP, supersede: Boolean = false) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            when (val outcome = repository.startTrip(route.routeId, route.label, direction, supersede)) {
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
                        _alert.value = DriverAlert(
                            "Run ended, but the school was not told",
                            "There was no signal. The school will close the run itself shortly. " +
                                if (outcome.discardedFixes > 0) {
                                    "${outcome.discardedFixes} unsent positions from the end of " +
                                        "the route could not be delivered."
                                } else {
                                    ""
                                },
                        )
                    }
                }
                EndOutcome.NoTrip -> TrackerServiceLauncher.stop(context)
            }
            _busy.value = false
        }
    }

    /**
     * The route book exists because the wire contract has no device-facing
     * endpoint that lists routes — see [SavedRoute]. Adding one is a setup
     * task, done once with the office, not something a driver does at 6:40am.
     */
    fun addRoute(routeId: String, label: String) {
        val id = routeId.trim()
        val name = label.trim().ifBlank { "Route" }
        if (id.isBlank()) return
        viewModelScope.launch {
            val existing = settingsStore.settings.first().routeBook.filterNot { it.routeId == id }
            settingsStore.saveRouteBook(existing + SavedRoute(id, name))
        }
    }

    fun removeRoute(routeId: String) {
        viewModelScope.launch {
            val remaining = settingsStore.settings.first().routeBook.filterNot { it.routeId == routeId }
            settingsStore.saveRouteBook(remaining)
        }
    }

    fun unpair() {
        viewModelScope.launch {
            repository.unpair()
            TrackerServiceLauncher.stop(context)
        }
    }

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
