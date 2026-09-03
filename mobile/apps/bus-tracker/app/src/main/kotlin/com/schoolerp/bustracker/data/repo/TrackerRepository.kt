package com.schoolerp.bustracker.data.repo

import com.schoolerp.bustracker.BuildConfig
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
import com.schoolerp.bustracker.data.remote.MarkChildRequest
import com.schoolerp.bustracker.data.remote.RollChild
import com.schoolerp.bustracker.data.remote.TripCheckRequest
import com.schoolerp.bustracker.data.remote.DriverSignInRequest
import com.schoolerp.bustracker.data.remote.EnrolRequest
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
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.MutableStateFlow
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

    /* True from a successful pairing until the driver has read the
       registration back and answered. The token is saved before the outcome
       is returned, and the root screen swapped to the run screen the instant
       `paired` flipped, so the "is that the bus you are driving?" card -- the
       one safeguard against a mis-pairing -- never rendered. */
    /* THE CARD THAT READ THE BUS BACK TO THE DRIVER, AND WHY IT IS GONE.

       A pairing used to name a vehicle, so the app stopped and asked the
       driver whether the registration on screen was the bus he was standing
       in. It no longer names one: the driver holds the phone account and the
       bus is read off the windscreen at the top of each run, which confirms
       the vehicle far better than a plate typed by the office and read back on
       a card. The flag is kept only so a build that still sets it somewhere
       cannot strand a paired phone -- nothing sets it any more, and the pair
       screen carries no card to clear it with. */
    private val _awaitingConfirmation = MutableStateFlow(false)
    val awaitingConfirmation: StateFlow<Boolean> = _awaitingConfirmation.asStateFlow()

    fun confirmPairing() {
        _awaitingConfirmation.value = false
    }

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
    /* ENROLLING AGAINST THE BUS IN FRONT OF THE DRIVER.

       driverSignIn below asks the server which bus HR has this person
       against, which is right for a driver who always takes the same one. A
       school where drivers swap buses needs the other direction: the handset
       says which bus it is standing next to, having read the sticker in the
       windscreen, and the server binds to that.

       The server retires whatever tracker that bus had, so scanning a second
       bus moves the handset rather than leaving two live trackers on one
       vehicle. */
    suspend fun enrolWithBus(
        rawBaseUrl: String,
        phone: String,
        pin: String,
        bus: String,
    ): PairOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(rawBaseUrl, allowInsecureHttpBuild && settings.allowInsecureHttp)
            .getOrElse { return PairOutcome.Rejected(it.message ?: "That address is not usable.") }
        return try {
            val response = api.enrol(
                baseUrl,
                EnrolRequest(
                    phone = phone.trim(),
                    pin = pin.trim(),
                    bus = bus.trim(),
                    deviceModel = device.deviceModel(),
                    androidVersion = device.androidVersion(),
                    appVersion = device.appVersion(),
                ),
            )
            settingsStore.setBaseUrl(baseUrl.value)
            if (response.routes.isNotEmpty()) {
                settingsStore.saveRouteBook(response.routes.map { SavedRoute(it.id, it.name) })
            }
            tokenStore.save(response.deviceId, response.deviceToken)
            if (response.sessionToken.isNotEmpty()) {
                tokenStore.saveSession(response.sessionToken, response.driver.orEmpty())
            }
            PairOutcome.Paired(response.vehicle.registrationNo, response.driver)
        } catch (failure: ApiFailure) {
            PairOutcome.Rejected(driverSignInMessage(failure))
        }
    }

    suspend fun driverSignIn(rawBaseUrl: String, phone: String, password: String): PairOutcome {
        val settings = settingsStore.settings.first()
        val baseUrl = BaseUrl.parse(rawBaseUrl, allowInsecureHttpBuild && settings.allowInsecureHttp)
            .getOrElse { return PairOutcome.Rejected(it.message ?: "That address is not usable.") }

        return try {
            val response = api.driverSignIn(
                baseUrl,
                DriverSignInRequest(
                    phone = phone,
                    password = password,
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
            /* The shift as well as the handset.
             *
             * Without this the driver is signed in as far as the bus is
             * concerned and not signed in as far as a trip is concerned, which
             * is the state that told him to sign in on a screen he had just
             * signed in on. Guarded on non-empty so an older server, which
             * sends no session, leaves any existing one alone. */
            if (response.sessionToken.isNotEmpty()) {
                tokenStore.saveSession(response.sessionToken, response.driver.orEmpty())
            }
            PairOutcome.Paired(response.vehicle.registrationNo, response.driver)
        } catch (failure: ApiFailure) {
            PairOutcome.Rejected(driverSignInMessage(failure))
        }
    }

    private fun driverSignInMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Unauthorized ->
            "That login and password did not match. Type the login exactly as the office " +
            "wrote it, which may be an email, a username or a mobile number."
        is ApiFailure.Rejected -> when (failure.status) {
            409 -> failure.detail
                ?: "No bus is assigned to you yet. Ask the office to put you against a vehicle."
            429 -> "Too many wrong attempts. Wait a few minutes, or ask the office to unlock it."
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
        _awaitingConfirmation.value = false
        // The buffer goes with the pairing. Those fixes belong to a school this
        // phone is no longer allowed to speak to.
        settingsStore.settings.first().activeTrip?.let { fixes.discardTrip(it.tripId) }
        stops.clear()
        settingsStore.clearPairing()
        // A driver who unpaired on purpose is not owed an explanation of why
        // he is looking at the sign-in screen, and showing him the last
        // rejection would read as a failure of the sign-in he is about to make.
        settingsStore.recordSignedOut(null)
        tokenStore.clear()
    }

    private fun pairingMessage(failure: ApiFailure): String = when (failure) {
        is ApiFailure.Network ->
            "Could not reach the school's server. Check the address and the phone's data connection."
        is ApiFailure.Unauthorized ->
            "That pairing code is not valid. Ask the office for a new one, codes expire after ten minutes."
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
    /* THE ROUTES ON THE BUS THAT WAS JUST SCANNED.

       Not cached into the route book: the book is the driver's own, and the
       bus is different every relief morning. Held for the length of the run
       screen and thrown away with the code. */
    suspend fun routesForBus(busCode: String): List<SavedRoute>? {
        val ctx = requireContext() ?: return null
        return try {
            api.routesForBus(ctx.baseUrl, ctx.token, busCode)
                .routes.map { SavedRoute(it.id, it.name) }
        } catch (failure: ApiFailure) {
            null
        }
    }

    /* THE REGISTER, ON THE BUS.

       Read fresh each time rather than cached: two adults on one run -- a
       driver and an attendant with a second handset -- must not each be
       working from their own idea of who is already aboard. */
    suspend fun roll(tripId: String): List<RollChild>? {
        val ctx = requireContext() ?: return null
        return try {
            api.roll(ctx.baseUrl, ctx.token, tripId).children
        } catch (failure: ApiFailure) {
            null
        }
    }

    /** Returns true when the school accepted the mark. */
    suspend fun markChild(tripId: String, studentId: String, status: String): Boolean {
        val ctx = requireContext() ?: return false
        val session = tokenStore.session() ?: return false
        return try {
            api.markChild(ctx.baseUrl, ctx.token, session, tripId,
                MarkChildRequest(studentId = studentId, status = status))
            true
        } catch (failure: ApiFailure) {
            false
        }
    }

    /** The pre-trip check. Null means the school never heard it. */
    suspend fun recordCheck(request: TripCheckRequest): Boolean? {
        val ctx = requireContext() ?: return null
        val session = tokenStore.session() ?: return null
        return try {
            api.recordCheck(ctx.baseUrl, ctx.token, session, request).cleared
        } catch (failure: ApiFailure) {
            null
        }
    }

    suspend fun signIn(phone: String, pin: String): SignInOutcome {
        val ctx = requireContext() ?: return SignInOutcome.NotPaired
        return try {
            val response = api.signIn(
                ctx.baseUrl, ctx.token, SignInRequest(phone = phone, password = pin),
            )
            tokenStore.saveSession(response.sessionToken, response.name)
            // Only when the server actually sent some. An empty list from an
            // older server must not wipe a book the driver is relying on.
            if (response.routes.isNotEmpty()) {
                settingsStore.saveRouteBook(
                    response.routes.map { SavedRoute(it.id, it.name) },
                )
            }
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
            "That login and password did not match. Type the login exactly as the office " +
            "wrote it, which may be an email, a username or a mobile number."
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
        /** The bus scanned for this run. Null keeps the paired one. */
        busCode: String? = null,
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
                    busCode = busCode?.takeIf { it.isNotBlank() },
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
                // A 409 with a code this app does not know now arrives as
                // Rejected rather than TripAlreadyOpen. On trip start the only
                // conflict the server defines is the open run, so it still
                // means what it used to -- but it carries the server's own
                // sentence, so a conflict added later reads correctly here
                // instead of claiming a run that is not there.
                is ApiFailure.Rejected -> if (failure.status == 409) {
                    StartOutcome.AlreadyOpen(
                        failure.detail
                            ?: "This bus already has a run open. Close it, or take it over.",
                    )
                } else {
                    StartOutcome.Failed(failure.reason)
                }
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
        val endedAt = time.nowMillis()

        if (ctx != null) {
            runCatching { flushBuffer(trip.tripId) }
        }

        /* The end is reported, or it is owed.

           This discarded the unsent buffer whenever the end call failed, on
           the grounds that the server refuses fixes for a closed run. But a
           run the server has not been told about is not closed: it stays open
           until the school's timeout sweep, and every fix from the tunnel at
           the end of the route would still be taken. So nothing is thrown
           away here. The fixes stay under the trip id, the end is written
           down as owed, and the flush worker settles both when there is
           signal. Only a server that says the run is gone ends it for good. */
        var reported = false
        var settled = ctx == null
        if (ctx != null) {
            try {
                reported = api.endTrip(
                    ctx.baseUrl,
                    ctx.token,
                    tokenStore.session().orEmpty(),
                    trip.tripId,
                    EndTripRequest(endedAt = Rfc3339.format(endedAt)),
                ).ended
                settled = true
            } catch (failure: ApiFailure) {
                BtLog.w("trip", "could not report end of ${trip.tripId}: ${failure.reason}")
                settled = failure.isFinalForTrip()
            }
        }

        stops.clear()
        settingsStore.closeTrip()
        val kept: Int
        if (settled) {
            val abandoned = fixes.discardTrip(trip.tripId)
            if (abandoned > 0) BtLog.w("trip", "discarded $abandoned fixes the server would refuse after close")
            settingsStore.clearPendingEnd()
            kept = 0
        } else {
            settingsStore.recordPendingEnd(trip.tripId, endedAt)
            kept = fixes.countFor(trip.tripId)
            BtLog.i("trip", "end of ${trip.tripId} owed; $kept fixes kept for the flush worker")
        }
        return EndOutcome.Ended(reportedToServer = reported, keptFixes = kept)
    }

    /**
     * Settles a run the driver ended without signal: the last fixes go up,
     * then the end. True when nothing is owed any more.
     */
    suspend fun finishPendingEnd(): Boolean {
        val pending = settingsStore.settings.first().pendingEnd ?: return true
        val ctx = requireContext()
        if (ctx == null) {
            fixes.discardTrip(pending.tripId)
            settingsStore.clearPendingEnd()
            return true
        }
        when (val flushed = runCatching { flushBuffer(pending.tripId) }.getOrNull()) {
            is PushOutcome.TripClosed, PushOutcome.NotPaired -> {
                // The server has closed it, or will never hear from this
                // token again. Either way the fixes have nowhere to go.
                fixes.discardTrip(pending.tripId)
                settingsStore.clearPendingEnd()
                return true
            }
            is PushOutcome.Deferred, null -> return false
            else -> Unit
        }
        val settled = try {
            api.endTrip(
                ctx.baseUrl,
                ctx.token,
                tokenStore.session().orEmpty(),
                pending.tripId,
                EndTripRequest(endedAt = Rfc3339.format(pending.endedAtMillis)),
            )
            true
        } catch (failure: ApiFailure) {
            BtLog.w("trip", "owed end of ${pending.tripId} still not reported: ${failure.reason}")
            failure.isFinalForTrip()
        }
        if (settled) {
            fixes.discardTrip(pending.tripId)
            settingsStore.clearPendingEnd()
        }
        return settled
    }

    /* A refusal that no retry will change: the run is not there to end, or
       this phone is no longer allowed to say anything about it. A session
       that lapsed answers 401 too, and so counts as final here — the school's
       sweep closes the run on the same last-heard rule the driver's end
       would have used, and the fixes were already pushed above. */
    private fun ApiFailure.isFinalForTrip(): Boolean =
        this is ApiFailure.NoSuchTrip || this is ApiFailure.Unauthorized

    /**
     * The server no longer accepts this phone's token: the office retired the
     * handset, or the driver signed in on a newer one.
     *
     * Everything goes, and it goes here rather than being left for the driver
     * to work out. A token that has been rejected once is rejected for ever,
     * so a phone that kept its pairing would sit on the run screen answering
     * 401 to every push and every heartbeat until the battery went, looking
     * for all the world like it was tracking. Clearing the pairing is what
     * puts the sign-in screen back in front of the driver, and [reason] is
     * what tells him why it is there.
     *
     * The buffer goes with it. Those fixes are addressed to a school this
     * handset is no longer allowed to speak to, and no later sign-in can
     * deliver them: the trip they belong to is not the trip the next session
     * would open.
     */
    suspend fun credentialRejected(reason: String) {
        BtLog.w("auth", "server rejected this device's token; clearing the pairing")
        val current = settingsStore.settings.first()
        current.activeTrip?.let { fixes.discardTrip(it.tripId) }
        current.pendingEnd?.let { fixes.discardTrip(it.tripId) }
        settingsStore.clearPendingEnd()
        stops.clear()
        settingsStore.clearPairing()
        settingsStore.recordSignedOut(reason)
        tokenStore.clear()
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
            settingsStore.recordPush(time.nowMillis())

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
            settingsStore.recordPushFailure(failure.reason)
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

    /** True when this call recorded the arrival; false if it was already on record. */
    suspend fun markStopArrived(tripId: String, stopId: String): Boolean =
        stops.markArrived(tripId, stopId, time.nowMillis()) > 0

    private data class CallContext(val baseUrl: BaseUrl, val token: String)

    private suspend fun requireContext(): CallContext? {
        val token = tokenStore.token() ?: return null
        val settings = settingsStore.settings.first()
        /* Every later call goes to the compiled address too, not only the
           sign-in. Fixing this in one place would have left a handset paired
           weeks ago still heartbeating and reporting positions at whatever
           host was typed into it then, which is the same fault moved rather
           than removed. A debug build keeps its stored override, because it is
           the only build that can still set one. */
        val raw = if (allowInsecureHttpBuild) {
            settings.baseUrl.ifBlank { BuildConfig.DEFAULT_BASE_URL }
        } else {
            BuildConfig.DEFAULT_BASE_URL
        }
        val baseUrl = BaseUrl
            .parse(raw, allowInsecureHttpBuild && settings.allowInsecureHttp)
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
    /** keptFixes is what waits on disk for the flush worker when the end could not be reported. */
    data class Ended(val reportedToServer: Boolean, val keptFixes: Int) : EndOutcome
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
