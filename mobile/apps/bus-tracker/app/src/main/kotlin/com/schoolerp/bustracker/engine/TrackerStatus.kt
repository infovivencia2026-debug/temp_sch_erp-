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
) {

    /** The one line the driver reads at a glance, on the notification. */
    val summary: String
        get() = when {
            locationBlocker != null -> locationBlocker.headline
            trip == null -> "No run open"
            pausedByServer -> "Paused by the school"
            bufferedFixes > 0 && !hasNetwork -> "No signal — holding $bufferedFixes fixes"
            bufferedFixes > 0 -> "Catching up — $bufferedFixes fixes to send"
            else -> "Reporting every ${pingSeconds}s"
        }

    /**
     * True when the school can currently see this bus. Deliberately strict:
     * anything that would leave the map stale counts as not reporting, because
     * an app that claims to be fine while the bus is missing is the failure
     * this whole feature is meant to remove.
     */
    val reporting: Boolean
        get() = trip != null && !pausedByServer && locationBlocker == null && serviceRunning
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
    data class StopReached(val stopName: String) : EngineEvent
}
