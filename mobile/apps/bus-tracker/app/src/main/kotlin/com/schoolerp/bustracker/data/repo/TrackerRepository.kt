package com.schoolerp.bustracker.data.repo

import com.schoolerp.bustracker.core.BaseUrl
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.core.Rfc3339
import com.schoolerp.bustracker.core.TimeSource
import com.schoolerp.bustracker.data.local.FixDao
import com.schoolerp.bustracker.data.local.FixEntity
import com.schoolerp.bustracker.data.local.StopDao
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.data.prefs.ActiveTrip
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.prefs.TokenStore
import com.schoolerp.bustracker.data.prefs.TrackerSettings
import com.schoolerp.bustracker.data.remote.ApiFailure
import com.schoolerp.bustracker.data.remote.ClaimRequest
import com.schoolerp.bustracker.data.remote.DriverSignInRequest
import com.schoolerp.bustracker.data.remote.EndTripRequest
import com.schoolerp.bustracker.data.remote.HeartbeatRequest
import com.schoolerp.bustracker.data.remote.PositionFix
import com.schoolerp.bustracker.data.remote.PositionsRequest
import com.schoolerp.bustracker.data.remote.SignInRequest
import com.schoolerp.bustracker.data.remote.StartTripRequest
import com.schoolerp.bustracker.data.remote.TrackerApi
import com.schoolerp.bustracker.device.DeviceStatusProvider
import com.schoolerp.bustracker.device.Fix
import com.schoolerp.bustracker.device.LocationPermissions
import com.schoolerp.bustracker.di.AllowInsecureHttpBuild
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The one place that knows how to talk to the server *and* to the disk, and the
 * only place that decides what may be deleted from the buffer.
 */
@Singleton
class TrackerRepository @Inject constructor(
    private val api: TrackerApi,
    private val tokenStore: TokenStore,
    private val settingsStore: SettingsStore,
    private val fixes: FixDao,
    private val stops: StopDao,
    private val device: DeviceStatusProvider,
    private val locationPermissions: LocationPermissions,
    private val time: TimeSource,
    @param:AllowInsecureHttpBuild private val allowInsecureHttpBuild: Boolean,
) {

    val paired: StateFlow<Boolean> = tokenStore.paired

    /** True while a driver is signed in on this handset. The run screen offers
        Sign in or Sign out from it, and startTrip refuses without it. */
    val signedIn get() = tokenStore.signedIn

    fun driverName(): String? = tokenStore.driverName()

    val settings: Flow<TrackerSettings> = settingsStore.settings

    val bufferDepth: Flow<Int> = fixes.observeBufferDepth()

    fun observeStops(tripId: String): Flow<List<StopEntity>> = stops.observeStops(tripId)

    // ------------------------------------------------------------- enrolment

    /* SIGNING IN AS THE DRIVER, which is now the ordinary way in.
     *
     * pair() below is kept for the schools already using pair codes and for a
     * bus with no driver assigned yet. This is what the screen offers first:
     * HR records who drives which bus, so the number and PIN the office issued
     * are enough, and the server returns the vehicle rather than the driver
     * naming it.
     *
     * Records the pairing exactly as pair() does, because from everything
     * downstream -- the service, the buffer, the trip -- a handset that signed
     * in and a handset that used a code are the same thing.
     */
    suspend fun driverSignIn(rawBaseUrl: String, phone: String, pin: String): PairOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(rawBaseUrl, allowInsecureHttpBuild && settings.allowInsecureHttp)
            .getOrElse { return PairOutcome.Rejected(it.message ?: "That address is not usable.") }

        return try {
            val response = api.driverSignIn(
                baseUrl,
                DriverSignInRequest(
                    phone = phone,
                    pin = pin,
                    deviceModel = device.deviceModel(),
                    androidVersion = device.androidVersion(),
                    appVersion = device.appVersion(),
                ),
            )
            settingsStore.setBaseUrl(baseUrl.value)
            settingsStore.recordPairing(
                deviceId = response.deviceId,
                institution = null,
                vehicleId = response.vehicle.id,
                vehicleRegistration = response.vehicle.registrationNo,
                pingSeconds = null,
            )
            /* The office's routes replace whatever the driver typed.

               Not merged with the existing book: the server is the authority on
               which routes this bus runs, and a stale hand-typed entry left
               beside them is the one somebody picks by accident. A bus with no
               routes assigned yet leaves the book alone rather than emptying
               it, so a school mid-setup does not lose what it had. */
            if (response.routes.isNotEmpty()) {
                settingsStore.saveRouteBook(
                    response.routes.map { SavedRoute(it.id, it.name) },
                )
            }
            tokenStore.save(response.deviceId, response.deviceToken)
            PairOutcome.Paired(response.vehicle.registrationNo, response.driver)
        } catch (failure: ApiFailure) {
            PairOutcome.Rejected(driverSignInMessage(failure))
        }
    }

    private fun driverSignInMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Unauthorized ->
            "That number and PIN did not match. Ask the office to check the number they have for you."
        is ApiFailure.Rejected -> when (failure.status) {
            409 -> failure.detail
                ?: "No bus is assigned to you yet. Ask the office to put you against a vehicle."
            429 -> "Too many wrong PINs. Wait a few minutes, or ask the office to unlock it."
            else -> failure.detail ?: "Could not sign in."
        }
        is ApiFailure.Malformed ->
            "The server answered in a way this app did not understand. Tell the office the app needs updating."
        else -> "Could not sign in (${failure.reason})."
    }

    suspend fun pair(rawBaseUrl: String, pairCode: String): PairOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(rawBaseUrl, allowInsecureHttpBuild && settings.allowInsecureHttp)
            .getOrElse { return PairOutcome.Rejected(it.message ?: "That address is not usable.") }

        val request = ClaimRequest(
            pairCode = pairCode,
            deviceName = device.deviceName(),
            deviceModel = device.deviceModel(),
            androidVersion = device.androidVersion(),
            appVersion = device.appVersion(),
        )

        return try {
            val response = api.claim(baseUrl, request)
            settingsStore.setBaseUrl(baseUrl.value)
            settingsStore.recordPairing(
                deviceId = response.deviceId,
                institution = response.institution?.name,
                vehicleId = response.vehicle.id,
                vehicleRegistration = response.vehicle.registrationNo,
                pingSeconds = response.pingSeconds,
            )
            // The token is stored last. If anything above fails the app is still
            // unpaired and the driver retries, rather than holding a credential
            // it has no configuration to use.
            tokenStore.save(response.deviceId, response.deviceToken)
            PairOutcome.Paired(response.vehicle.registrationNo, response.institution?.name)
        } catch (failure: ApiFailure) {
            PairOutcome.Rejected(pairingMessage(failure))
        }
    }

    suspend fun unpair() {
        // The buffer goes with the pairing. Those fixes belong to a school this
        // phone is no longer allowed to speak to.
        settingsStore.settings.first().activeTrip?.let { fixes.discardTrip(it.tripId) }
        stops.clear()
        settingsStore.clearPairing()
        tokenStore.clear()
    }

    private fun pairingMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Network ->
            "Could not reach the school's server. Check the address and the phone's data connection."
        is ApiFailure.Unauthorized ->
            "That pairing code is not valid. Ask the office for a new one — codes expire after ten minutes."
        is ApiFailure.Malformed ->
            "The server answered in a way this app did not understand. Tell the office the app needs updating."
        else -> "Pairing failed (${failure.reason})."
    }

    // -------------------------------------------------------------- the shift

    /* SIGNING THE DRIVER IN.
     *
     * Separate from pairing on purpose. Pairing is done once, by the office,
     * and says which bus this handset is; it survives a phone being handed to
     * the next driver. Signing in is done at the start of a shift, by the
     * person driving, and says who to attribute the run to.
     *
     * The server refuses trip start and end without it, which is why this
     * exists at all: the app paired, heartbeated and reported position
     * perfectly while the Start button returned 401 on every handset in the
     * field, and nothing in the office could see that.
     */
    suspend fun signIn(phone: String, pin: String): SignInOutcome {
        val ctx = requireContext() ?: return SignInOutcome.NotPaired
        return try {
            val response = api.signIn(ctx.baseUrl, ctx.token, SignInRequest(phone = phone, pin = pin))
            tokenStore.saveSession(response.sessionToken, response.name)
            SignInOutcome.SignedIn(response.name)
        } catch (failure: ApiFailure) {
            SignInOutcome.Rejected(signInMessage(failure))
        }
    }

    /* Signing out leaves the device paired and does NOT end an open trip --
     * the server's rule, and the right one: a driver who signs out with the
     * bus still moving has made a mistake, and dropping the children off the
     * parents' map is not how to correct it. */
    suspend fun signOut() {
        val ctx = requireContext()
        if (ctx != null) runCatching { api.signOut(ctx.baseUrl, ctx.token) }
        tokenStore.clearSession()
    }

    private fun signInMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Unauthorized ->
            "That phone number and PIN did not match. Ask the office to check the number they have for you."
        /* 429 pin_locked: the server counts failed PINs and locks the number
           for a while. Rejected carries the status, so this reads it rather
           than inventing a case ApiFailure does not have. */
        is ApiFailure.Rejected ->
            if (failure.status == 429) {
                "Too many wrong PINs. Wait a few minutes, or ask the office to unlock it."
            } else {
                failure.detail ?: "Could not sign in."
            }
        is ApiFailure.Malformed ->
            "The server answered in a way this app did not understand. Tell the office the app needs updating."
        else -> "Could not sign in (${failure.reason})."
    }

    // ----------------------------------------------------------------- trips

    suspend fun startTrip(
        routeId: String,
        routeName: String,
        direction: String,
        supersede: Boolean = false,
    ): StartOutcome {
        val ctx = requireContext() ?: return StartOutcome.NotPaired
        // The server refuses this route without a driver session, so refusing
        // here first turns a 401 nobody can read into a sentence that says
        // what to do.
        val session = tokenStore.session() ?: return StartOutcome.NotSignedIn
        val startedAtMillis = time.nowMillis()

        return try {
            val response = api.startTrip(
                ctx.baseUrl,
                ctx.token,
                session,
                StartTripRequest(
                    routeId = routeId,
                    direction = direction,
                    startedAt = Rfc3339.format(startedAtMillis),
                    supersede = supersede,
                ),
            )
            stops.replaceAll(
                response.stops.map { stop ->
                    StopEntity(
                        tripId = response.tripId,
                        stopId = stop.id,
                        name = stop.name,
                        sequence = stop.sequence,
                        latitude = stop.latitude,
                        longitude = stop.longitude,
                        geofenceM = stop.geofenceM,
                        scheduledAt = stop.scheduledAt,
                    )
                },
            )
            stops.pruneOtherThan(response.tripId)
            settingsStore.openTrip(
                ActiveTrip(
                    tripId = response.tripId,
                    routeId = routeId,
                    routeName = routeName,
                    direction = direction,
                    startedAtMillis = startedAtMillis,
                ),
            )
            BtLog.i("trip", "opened ${response.tripId} with ${response.stops.size} stops")
            StartOutcome.Started(response.tripId, response.stops.size)
        } catch (failure: ApiFailure) {
            when (failure) {
                is ApiFailure.TripAlreadyOpen -> StartOutcome.AlreadyOpen(
                    failure.detail
                        ?: "This bus already has a run open. Close it, or take it over.",
                )
                is ApiFailure.Unauthorized -> StartOutcome.NotPaired
                else -> StartOutcome.Failed(failure.reason)
            }
        }
    }

    /**
     * Ends the run, after one last attempt to hand over whatever is still
     * buffered. The order matters: fixes filed after the trip closes are
     * refused with `no_such_trip`, so the flush has to come first or the last
     * few minutes of the route — the part where the children got off — is the
     * part that is lost.
     */
    suspend fun endTrip(): EndOutcome {
        val settings = settingsStore.settings.first()
        val trip = settings.activeTrip ?: return EndOutcome.NoTrip
        val ctx = requireContext()

        if (ctx != null) {
            runCatching { flushBuffer(trip.tripId) }
        }

        var reported = false
        if (ctx != null) {
            reported = try {
                api.endTrip(
                    ctx.baseUrl,
                    ctx.token,
                    tokenStore.session().orEmpty(),
                    trip.tripId,
                    EndTripRequest(endedAt = Rfc3339.format(time.nowMillis())),
                ).ended
            } catch (failure: ApiFailure) {
                // A run the server never heard end is closed by its own timeout
                // sweeper with reason 'timeout'. That is a worse record than
                // 'driver' but it is not a reason to keep the phone reporting.
                BtLog.w("trip", "could not report end of ${trip.tripId}: ${failure.reason}")
                false
            }
        }

        val abandoned = fixes.discardTrip(trip.tripId)
        stops.clear()
        settingsStore.closeTrip()
        if (abandoned > 0) {
            BtLog.w("trip", "discarded $abandoned fixes the server would refuse after close")
        }
        return EndOutcome.Ended(reportedToServer = reported, discardedFixes = abandoned)
    }

    /** The server closed the run underneath us. Same local cleanup, no end call. */
    suspend fun abandonTrip(tripId: String) {
        fixes.discardTrip(tripId)
        stops.clear()
        settingsStore.closeTrip()
    }

    // ------------------------------------------------------------- positions

    /**
     * Writes a fix to disk. Nothing here uploads: the buffer is the durable
     * record, and a bus through a dead zone must not lose its history because
     * the push happened to fail.
     */
    suspend fun bufferFix(tripId: String, fix: Fix) {
        fixes.insert(
            FixEntity(
                tripId = tripId,
                recordedAtSeconds = Rfc3339.toEpochSecond(fix.atMillis),
                recordedAt = Rfc3339.format(fix.atMillis),
                latitude = fix.latitude,
                longitude = fix.longitude,
                speedKmph = fix.speedKmph,
                headingDeg = fix.headingDeg,
                accuracyM = fix.accuracyM,
            ),
        )
    }

    /**
     * Uploads one batch of at most 200 and deletes exactly what the server
     * acknowledged.
     *
     * Returns what the server said about the run, so the caller can obey
     * `ping_seconds`, `paused` and `trip_open` without a second call.
     */
    suspend fun pushOneBatch(tripId: String): PushOutcome {
        val ctx = requireContext() ?: return PushOutcome.NotPaired
        val batch = fixes.nextBatch(tripId, TrackerApi.MAX_FIXES_PER_PUSH)
        if (batch.isEmpty()) return PushOutcome.NothingToSend

        return try {
            val response = api.postPositions(
                ctx.baseUrl,
                ctx.token,
                PositionsRequest(
                    tripId = tripId,
                    fixes = batch.map {
                        PositionFix(
                            recordedAt = it.recordedAt,
                            latitude = it.latitude,
                            longitude = it.longitude,
                            speedKmph = it.speedKmph,
                            headingDeg = it.headingDeg,
                            accuracyM = it.accuracyM,
                        )
                    },
                ),
            )

            // Matched on the instant, not the string: the server formats the
            // acknowledgement in its own zone. See Rfc3339.acknowledgedSeconds.
            val acknowledged = Rfc3339.acknowledgedSeconds(response.accepted)
            val toDelete = batch.map { it.recordedAtSeconds }.filter { it in acknowledged }
            if (toDelete.isNotEmpty()) fixes.deleteAcknowledged(tripId, toDelete)

            settingsStore.applyServerDirectives(response.pingSeconds, response.paused)
            settingsStore.recordPush(time.nowMillis(), error = null)

            if (!response.tripOpen) {
                PushOutcome.TripClosed(
                    pingSeconds = response.pingSeconds,
                    paused = response.paused,
                )
            } else {
                PushOutcome.Sent(
                    sent = batch.size,
                    acknowledged = toDelete.size,
                    remaining = fixes.countFor(tripId),
                    pingSeconds = response.pingSeconds,
                    paused = response.paused,
                )
            }
        } catch (failure: ApiFailure) {
            settingsStore.recordPush(time.nowMillis(), error = failure.reason)
            when (failure) {
                is ApiFailure.NoSuchTrip -> PushOutcome.TripClosed(null, null)
                is ApiFailure.Unauthorized -> PushOutcome.NotPaired
                is ApiFailure.SkewedClock -> {
                    // Not retryable and not the batch's fault. Dropping it is
                    // the only way anything later ever gets through, and the
                    // driver is told rather than left with a silent tracker.
                    fixes.deleteAcknowledged(tripId, batch.map { it.recordedAtSeconds })
                    PushOutcome.ClockWrong(failure.serverTime)
                }
                else -> PushOutcome.Deferred(failure)
            }
        }
    }

    /** Drains the buffer batch by batch until it stops making progress. */
    suspend fun flushBuffer(tripId: String): PushOutcome {
        var last: PushOutcome = PushOutcome.NothingToSend
        while (true) {
            val outcome = pushOneBatch(tripId)
            last = outcome
            if (outcome !is PushOutcome.Sent || outcome.remaining == 0 || outcome.acknowledged == 0) {
                return last
            }
        }
    }

    // ------------------------------------------------------------- heartbeat

    suspend fun heartbeat(): HeartbeatOutcome {
        val ctx = requireContext() ?: return HeartbeatOutcome.NotPaired
        return try {
            val response = api.heartbeat(
                ctx.baseUrl,
                ctx.token,
                HeartbeatRequest(
                    batteryPct = device.batteryPct(),
                    charging = device.charging(),
                    // Read now, not cached. A permission revoked from Settings
                    // ten minutes ago must show up as false on this heartbeat.
                    locationOk = locationPermissions.locationOk(),
                    appVersion = device.appVersion(),
                ),
            )
            settingsStore.applyServerDirectives(response.pingSeconds, response.paused)
            settingsStore.recordHeartbeat(time.nowMillis())
            HeartbeatOutcome.Acknowledged(response.pingSeconds, response.paused)
        } catch (failure: ApiFailure) {
            if (failure is ApiFailure.Unauthorized) HeartbeatOutcome.NotPaired
            else HeartbeatOutcome.Failed(failure.reason)
        }
    }

    // ------------------------------------------------------------------ misc

    suspend fun markStopArrived(tripId: String, stopId: String) {
        stops.markArrived(tripId, stopId, time.nowMillis())
    }

    private data class CallContext(val baseUrl: BaseUrl, val token: String)

    private suspend fun requireContext(): CallContext? {
        val token = tokenStore.token() ?: return null
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl
            .parse(settings.baseUrl, allowInsecureHttpBuild && settings.allowInsecureHttp)
            .getOrNull() ?: return null
        return CallContext(baseUrl, token)
    }
}

sealed interface PairOutcome {
    data class Paired(val vehicleRegistration: String, val institution: String?) : PairOutcome
    data class Rejected(val message: String) : PairOutcome
}

sealed interface StartOutcome {
    data class Started(val tripId: String, val stopCount: Int) : StartOutcome
    data class AlreadyOpen(val message: String) : StartOutcome
    data class Failed(val reason: String) : StartOutcome
    data object NotPaired : StartOutcome
    /** Paired, but nobody has signed in this shift. The server would answer
        401 not_signed_in; this says so before the request is made. */
    data object NotSignedIn : StartOutcome
}

sealed interface SignInOutcome {
    data class SignedIn(val name: String) : SignInOutcome
    data class Rejected(val message: String) : SignInOutcome
    data object NotPaired : SignInOutcome
}

sealed interface EndOutcome {
    data class Ended(val reportedToServer: Boolean, val discardedFixes: Int) : EndOutcome
    data object NoTrip : EndOutcome
}

sealed interface PushOutcome {
    data class Sent(
        val sent: Int,
        val acknowledged: Int,
        val remaining: Int,
        val pingSeconds: Int?,
        val paused: Boolean?,
    ) : PushOutcome

    data object NothingToSend : PushOutcome

    /** The server says this run is over. Stop reporting and tell the driver. */
    data class TripClosed(val pingSeconds: Int?, val paused: Boolean?) : PushOutcome

    /** Temporary. The batch stays on disk and goes again. */
    data class Deferred(val failure: com.schoolerp.bustracker.data.remote.ApiFailure) : PushOutcome

    data class ClockWrong(val serverTime: String?) : PushOutcome

    data object NotPaired : PushOutcome
}

sealed interface HeartbeatOutcome {
    data class Acknowledged(val pingSeconds: Int?, val paused: Boolean?) : HeartbeatOutcome
    data class Failed(val reason: String) : HeartbeatOutcome
    data object NotPaired : HeartbeatOutcome
}
