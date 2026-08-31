package com.schoolerp.bustracker.engine

import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.core.TimeSource
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.repo.HeartbeatOutcome
import com.schoolerp.bustracker.data.repo.PushOutcome
import com.schoolerp.bustracker.data.repo.TrackerRepository
import com.schoolerp.bustracker.device.DeviceStatusProvider
import com.schoolerp.bustracker.device.Fix
import com.schoolerp.bustracker.device.LocationPermissions
import com.schoolerp.bustracker.device.LocationSource
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The loops that keep a bus on the map: collect, buffer, push, heartbeat.
 *
 * All four obey the server. `ping_seconds` comes back on every push and every
 * heartbeat, and it is what the location subscription and the push cadence are
 * rebuilt around — the phone never picks its own interval, because battery is
 * the school's trade against freshness and a handset choosing for itself is a
 * handset flat by two o'clock.
 */
@Singleton
class TripEngine @Inject constructor(
    private val repository: TrackerRepository,
    private val settingsStore: SettingsStore,
    private val locationSource: LocationSource,
    private val locationPermissions: LocationPermissions,
    private val device: DeviceStatusProvider,
    private val time: TimeSource,
) {

    private val _events = MutableSharedFlow<EngineEvent>(replay = 0, extraBufferCapacity = 16)
    val events: SharedFlow<EngineEvent> = _events.asSharedFlow()

    private val _lastFixAt = MutableStateFlow(0L)
    val lastFixAt: StateFlow<Long> = _lastFixAt.asStateFlow()

    private val _serviceRunning = MutableStateFlow(false)
    val serviceRunning: StateFlow<Boolean> = _serviceRunning.asStateFlow()

    /** The device snapshot the status screen reads; refreshed on demand and on every loop. */
    private val _deviceSnapshot = MutableStateFlow(DeviceSnapshot())
    val deviceSnapshot: StateFlow<DeviceSnapshot> = _deviceSnapshot.asStateFlow()

    /**
     * Set once the server has rejected this device's token, and never unset
     * for the life of the process.
     *
     * A revoked token is not a transient failure: the office retired the
     * handset, or the driver signed in on a newer one, and every later call
     * carries the same dead credential. Without this latch the push loop and
     * the heartbeat loop would each go on answering 401 every ping until the
     * battery died, raising the same notification over and over while the run
     * screen still claimed the bus was being tracked.
     */
    private val credentialRejected = java.util.concurrent.atomic.AtomicBoolean(false)

    fun publishServiceRunning(running: Boolean) {
        _serviceRunning.value = running
    }

    fun refreshDeviceSnapshot() {
        _deviceSnapshot.value = DeviceSnapshot(
            locationBlocker = locationPermissions.blocker(),
            hasNetwork = device.hasNetwork(),
            ignoringBatteryOptimisations = device.ignoringBatteryOptimisations(),
            notificationsAllowed = device.notificationsAllowed(),
        )
    }

    /** Runs until cancelled, which is when the service stops. */
    suspend fun run() = coroutineScope {
        refreshDeviceSnapshot()
        launch { collectFixes() }
        launch { pushLoop() }
        launch { heartbeatLoop() }
    }

    /**
     * Subscribes to location for as long as a run is open and unpaused, and
     * resubscribes whenever the server changes the interval.
     *
     * The subscription is torn down the moment the run ends. That is the
     * privacy promise the contract makes in as many words: the phone is the
     * driver's own and does not stop existing at 4pm, so nothing is collected
     * outside a trip the driver deliberately opened.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun collectFixes() {
        settingsStore.settings
            .map { CollectionPlan(it.activeTrip?.tripId, it.pingSeconds, it.paused) }
            .distinctUntilChanged()
            .flatMapLatest { plan ->
                if (plan.tripId == null || plan.paused) {
                    emptyFlow()
                } else {
                    BtLog.i("engine", "collecting every ${plan.pingSeconds}s for ${plan.tripId}")
                    locationSource.fixes(plan.pingSeconds)
                }
            }
            .collect { fix -> onFix(fix) }
    }

    private suspend fun onFix(fix: Fix) {
        val trip = settingsStore.settings.first().activeTrip ?: return
        repository.bufferFix(trip.tripId, fix)
        _lastFixAt.value = time.nowMillis()

        // Judged here, offline, from the radii that came down with the trip.
        val stops = repository.observeStops(trip.tripId).first()
        GeofenceWatcher(stops).arrivalsFor(fix).forEach { stop ->
            repository.markStopArrived(trip.tripId, stop.stopId)
            _events.tryEmit(EngineEvent.StopReached(stop.name))
        }
    }

    /**
     * Pushes whatever is buffered, no faster than `ping_seconds`.
     *
     * A push that succeeds and leaves fixes behind loops immediately rather
     * than waiting: that is a bus coming out of a dead zone with an hour of
     * history, and making it wait a ping per 200 fixes would leave the map
     * behind the bus for the rest of the route.
     */
    private suspend fun pushLoop() {
        while (true) {
            val settings = settingsStore.settings.first()
            val trip = settings.activeTrip
            var pauseFor = settings.pingSeconds.toLong()

            if (trip != null && !settings.paused) {
                when (val outcome = repository.pushOneBatch(trip.tripId)) {
                    is PushOutcome.Sent -> {
                        if (outcome.remaining > 0 && outcome.acknowledged > 0) pauseFor = 0
                        outcome.pingSeconds?.let { pauseFor = minOf(pauseFor, it.toLong()) }
                    }
                    is PushOutcome.TripClosed -> {
                        BtLog.i("engine", "server closed ${trip.tripId}; stopping")
                        repository.abandonTrip(trip.tripId)
                        _events.tryEmit(EngineEvent.TripClosedByServer(trip.tripId))
                    }
                    is PushOutcome.ClockWrong -> _events.tryEmit(EngineEvent.ClockWrong(outcome.serverTime))
                    is PushOutcome.NotPaired -> {
                        rejectCredential()
                        return
                    }
                    is PushOutcome.Deferred -> {
                        val failure = outcome.failure
                        // too_fast names its own wait; anything else keeps the
                        // buffer on disk and tries again next ping.
                        val tooFast =
                            (failure as? com.schoolerp.bustracker.data.remote.ApiFailure.TooFast)
                                ?.retryAfterSeconds
                        if (tooFast != null) pauseFor = maxOf(pauseFor, tooFast.toLong())
                    }
                    PushOutcome.NothingToSend -> Unit
                }
            }

            refreshDeviceSnapshot()
            if (pauseFor > 0) delay(pauseFor * 1_000)
        }
    }

    /**
     * The heartbeat runs whether or not a trip is open, because its whole point
     * is `location_ok`: the office needs to know the permission was revoked
     * before the 3pm run, not after it failed to appear.
     */
    private suspend fun heartbeatLoop() {
        while (true) {
            when (val outcome = repository.heartbeat()) {
                is HeartbeatOutcome.NotPaired -> {
                    rejectCredential()
                    return
                }
                is HeartbeatOutcome.Failed ->
                    BtLog.w("engine", "heartbeat failed: ${outcome.reason}")
                is HeartbeatOutcome.Acknowledged -> Unit
            }
            delay(heartbeatIntervalMillis())
        }
    }

    /**
     * Clears the pairing and tells the driver, once.
     *
     * The clearing is what stops the reporting for good and what puts the
     * sign-in screen back in front of him; the event is what says so while he
     * is still holding the phone.
     */
    private suspend fun rejectCredential() {
        if (!credentialRejected.compareAndSet(false, true)) return
        BtLog.w("engine", "device token rejected; stopping every loop")
        repository.credentialRejected(
            "The school's server no longer accepts this phone. It was either taken off this " +
                "bus in the office, or you signed in on another handset. Sign in again to " +
                "carry on.",
        )
        _events.tryEmit(EngineEvent.Unpaired)
    }

    /**
     * The latch is one-way per credential, not per process.
     *
     * It is an AtomicBoolean on a singleton that lives as long as the app, and
     * nothing cleared it. So a driver whose token was revoked signed in again,
     * got a working token, pressed Start Run, and every loop returned at the
     * first check without sending anything: the bus reported nothing until the
     * app was force-stopped, and the screen gave no reason because from its
     * side the sign-in had succeeded.
     *
     * Called on a successful sign-in, which is the only event that makes the
     * old rejection stale.
     */
    fun credentialAccepted() {
        if (credentialRejected.getAndSet(false)) {
            BtLog.i("engine", "new credential accepted; loops may run again")
        }
    }

    /**
     * Three pings apart, floored at a minute and capped at five. The heartbeat
     * carries no position and is not what keeps the map fresh, so paying for it
     * every ping would be battery spent on nothing.
     */
    private suspend fun heartbeatIntervalMillis(): Long {
        val ping = settingsStore.settings.first().pingSeconds
        return (ping * 3L).coerceIn(60L, 300L) * 1_000
    }

    private data class CollectionPlan(
        val tripId: String?,
        val pingSeconds: Int,
        val paused: Boolean,
    )
}

data class DeviceSnapshot(
    val locationBlocker: com.schoolerp.bustracker.device.LocationBlocker? = null,
    val hasNetwork: Boolean = true,
    val ignoringBatteryOptimisations: Boolean = true,
    val notificationsAllowed: Boolean = true,
)

/**
 * The single object the notification and the run screen both read, assembled
 * from the settings, the buffer depth and the device snapshot.
 */
@Singleton
class StatusAggregator @Inject constructor(
    private val repository: TrackerRepository,
    private val engine: TripEngine,
    private val time: TimeSource,
) {

    /**
     * A clock the status can be measured against.
     *
     * How far behind the school's map is cannot be derived from the settings
     * alone: nothing changes on disk while a phone sits in a dead zone, so a
     * status assembled only from stored values keeps reporting the same
     * cheerful sentence for the whole ten minutes. This is what makes the
     * screen and the notification age.
     */
    private val ticks: kotlinx.coroutines.flow.Flow<Long> = kotlinx.coroutines.flow.flow {
        while (true) {
            emit(time.nowMillis())
            delay(TICK_MILLIS)
        }
    }

    private val parts: kotlinx.coroutines.flow.Flow<TrackerStatus> = combine(
        repository.settings,
        repository.bufferDepth,
        engine.deviceSnapshot,
        engine.lastFixAt,
        engine.serviceRunning,
    ) { settings, buffered, snapshot, lastFixAt, running ->
        TrackerStatus(
            vehicleRegistration = settings.vehicleRegistration,
            institution = settings.institution,
            trip = settings.activeTrip,
            pingSeconds = settings.pingSeconds,
            pausedByServer = settings.paused,
            bufferedFixes = buffered,
            lastFixAtMillis = lastFixAt,
            lastPushAtMillis = settings.lastPushAt,
            lastServerError = settings.lastServerError,
            locationBlocker = snapshot.locationBlocker,
            hasNetwork = snapshot.hasNetwork,
            ignoringBatteryOptimisations = snapshot.ignoringBatteryOptimisations,
            notificationsAllowed = snapshot.notificationsAllowed,
            serviceRunning = running,
        )
    }

    val status: kotlinx.coroutines.flow.Flow<TrackerStatus> =
        combine(parts, ticks) { part, now -> part.copy(nowMillis = now) }

    private companion object {
        /** Five seconds. Cheap, and finer than the minute the screen counts in. */
        const val TICK_MILLIS = 5_000L
    }
}
