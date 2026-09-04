package com.schoolerp.bustracker.engine

import com.schoolerp.bustracker.data.prefs.ActiveTrip
import com.schoolerp.bustracker.device.LocationBlocker

/**
 * What is true right now, in one object, so the notification and the run screen
 * cannot disagree about whether the bus is being tracked.
 */
data class TrackerStatus(
    val vehicleRegistration: String? = null,
    val institution: String? = null,
    val trip: ActiveTrip? = null,
    val pingSeconds: Int = 20,
    val pausedByServer: Boolean = false,
    val bufferedFixes: Int = 0,
    val lastFixAtMillis: Long = 0L,
    val lastPushAtMillis: Long = 0L,
    val lastServerError: String? = null,
    val locationBlocker: LocationBlocker? = null,
    val hasNetwork: Boolean = true,
    val ignoringBatteryOptimisations: Boolean = true,
    val notificationsAllowed: Boolean = true,
    val serviceRunning: Boolean = false,
    /**
     * Now, as the aggregator saw it. Zero in the tests and in the first frame
     * before a tick arrives, which is why every use of it below is guarded:
     * an unknown clock must never make a healthy phone read as stale.
     */
    val nowMillis: Long = 0L,
) {

    /**
     * How long the school's map has been behind this bus.
     *
     * Measured from the last push the server actually accepted, not from the
     * last one attempted, and only while there is something waiting to send.
     * Before the first successful push of a run the run's own start is the
     * baseline, because a phone that has never once delivered is exactly the
     * case worth showing.
     */
    val behindMillis: Long
        get() {
            if (bufferedFixes == 0 || nowMillis == 0L) return 0L
            val since = if (lastPushAtMillis > 0L) lastPushAtMillis else trip?.startedAtMillis ?: 0L
            if (since == 0L) return 0L
            return (nowMillis - since).coerceAtLeast(0L)
        }

    /**
     * A backlog old enough that the office is looking at a bus that is no
     * longer where the map says.
     *
     * Two minutes rather than one ping: a single missed push is ordinary, and
     * a card that flickers between "seen" and "not seen" every twenty seconds
     * teaches a driver to ignore it.
     */
    val behind: Boolean get() = behindMillis >= BEHIND_AFTER_MILLIS

    private val behindMinutes: Long get() = behindMillis / 60_000

    /** The one line the driver reads at a glance, on the notification. */
    val summary: String
        get() = when {
            locationBlocker != null -> locationBlocker.headline
            trip == null -> "No run open"
            pausedByServer -> "Paused by the school"
            behind && !hasNetwork ->
                "No signal for ${behindMinutes} min, holding $bufferedFixes fixes"
            behind -> "The school's map is ${behindMinutes} min behind, $bufferedFixes fixes to send"
            bufferedFixes > 0 && !hasNetwork -> "No signal, holding $bufferedFixes fixes"
            bufferedFixes > 0 -> "Catching up, $bufferedFixes fixes to send"
            else -> "Reporting every ${pingSeconds}s"
        }

    /**
     * True when the school can currently see this bus. Deliberately strict:
     * anything that would leave the map stale counts as not reporting, because
     * an app that claims to be fine while the bus is missing is the failure
     * this whole feature is meant to remove.
     */
    val reporting: Boolean
        get() = trip != null && !pausedByServer && locationBlocker == null && serviceRunning &&
            // A phone that is buffering is not being seen, whatever else is
            // healthy. The card used to say "The school can see this bus" over
            // a line saying there was no signal, which is the two-sentence
            // version of the lie this class exists to prevent.
            !behind

    companion object {
        const val BEHIND_AFTER_MILLIS = 120_000L
    }
}

/**
 * Things the driver must be told about, as they happen. A shared flow rather
 * than state, because "the office closed your run" is an event that has to be
 * seen once even if the screen was off when it happened.
 */
sealed interface EngineEvent {
    /** `trip_open: false` — the server closed the run underneath us. */
    data class TripClosedByServer(val tripId: String) : EngineEvent

    /** `422 skewed_clock`. Nothing this phone records can be trusted until fixed. */
    data class ClockWrong(val serverTime: String?) : EngineEvent

    /** The token was rejected. The app is inert until someone re-pairs. */
    data object Unpaired : EngineEvent

    /** Local geofence verdict, shown to the driver. The server keeps its own. */
    data class StopReached(val stopId: String, val stopName: String) : EngineEvent

    /** A message from the office, new since the last heartbeat. */
    data class Notice(val id: String, val body: String) : EngineEvent
}
