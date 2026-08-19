package com.schoolerp.bustracker.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore("tracker_settings")

/**
 * Everything about the pairing and the open run except the credential. Plain
 * DataStore is the right home for this — it is configuration and a resumable
 * position, not a secret — and the token deliberately lives elsewhere, in
 * [TokenStore].
 *
 * The open trip is stored here rather than held in the service, because the
 * service is the thing that gets killed. A driver whose phone rebooted on a
 * pothole must come back to the same run, not to a fresh start screen with
 * forty minutes of children unaccounted for.
 */
@Singleton
class SettingsStore @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    private val store get() = context.settingsDataStore

    private val json = Json { ignoreUnknownKeys = true }

    val settings: Flow<TrackerSettings> = store.data.map { prefs ->
        TrackerSettings(
            baseUrl = prefs[KEY_BASE_URL].orEmpty(),
            institution = prefs[KEY_INSTITUTION],
            deviceId = prefs[KEY_DEVICE_ID],
            vehicleId = prefs[KEY_VEHICLE_ID],
            vehicleRegistration = prefs[KEY_VEHICLE_REGISTRATION],
            pingSeconds = prefs[KEY_PING_SECONDS] ?: TrackerSettings.DEFAULT_PING_SECONDS,
            paused = prefs[KEY_PAUSED] ?: false,
            allowInsecureHttp = prefs[KEY_ALLOW_INSECURE] ?: false,
            lastPushAt = prefs[KEY_LAST_PUSH_AT] ?: 0L,
            lastHeartbeatAt = prefs[KEY_LAST_HEARTBEAT_AT] ?: 0L,
            lastServerError = prefs[KEY_LAST_SERVER_ERROR],
            activeTrip = readTrip(prefs),
            routeBook = readRouteBook(prefs),
        )
    }

    suspend fun setBaseUrl(url: String) = edit { it[KEY_BASE_URL] = url }

    suspend fun setAllowInsecureHttp(allow: Boolean) = edit { it[KEY_ALLOW_INSECURE] = allow }

    suspend fun recordPairing(
        deviceId: String,
        institution: String?,
        vehicleId: String?,
        vehicleRegistration: String,
        pingSeconds: Int?,
    ) = edit { prefs ->
        prefs[KEY_DEVICE_ID] = deviceId
        institution?.let { prefs[KEY_INSTITUTION] = it }
        vehicleId?.let { prefs[KEY_VEHICLE_ID] = it }
        prefs[KEY_VEHICLE_REGISTRATION] = vehicleRegistration
        pingSeconds?.let { prefs[KEY_PING_SECONDS] = TrackerSettings.clampPing(it) }
    }

    /**
     * The server owns the cadence and the pause. The phone stores what it was
     * told, clamped to the contract's own 5–300 range so a bad value cannot
     * turn into a fix every millisecond and a flat battery by ten o'clock.
     */
    suspend fun applyServerDirectives(pingSeconds: Int?, paused: Boolean?) = edit { prefs ->
        pingSeconds?.let { prefs[KEY_PING_SECONDS] = TrackerSettings.clampPing(it) }
        paused?.let { prefs[KEY_PAUSED] = it }
    }

    suspend fun recordPush(at: Long, error: String?) = edit {
        it[KEY_LAST_PUSH_AT] = at
        if (error == null) it.remove(KEY_LAST_SERVER_ERROR) else it[KEY_LAST_SERVER_ERROR] = error
    }

    suspend fun recordHeartbeat(at: Long) = edit { it[KEY_LAST_HEARTBEAT_AT] = at }

    suspend fun openTrip(trip: ActiveTrip) = edit {
        it[KEY_TRIP_ID] = trip.tripId
        it[KEY_TRIP_ROUTE_ID] = trip.routeId
        it[KEY_TRIP_ROUTE_NAME] = trip.routeName
        it[KEY_TRIP_DIRECTION] = trip.direction
        it[KEY_TRIP_STARTED_AT] = trip.startedAtMillis
    }

    suspend fun closeTrip() = edit {
        it.remove(KEY_TRIP_ID)
        it.remove(KEY_TRIP_ROUTE_ID)
        it.remove(KEY_TRIP_ROUTE_NAME)
        it.remove(KEY_TRIP_DIRECTION)
        it.remove(KEY_TRIP_STARTED_AT)
    }

    suspend fun saveRouteBook(routes: List<SavedRoute>) =
        edit { it[KEY_ROUTE_BOOK] = json.encodeToString(routes) }

    /** Unpairing wipes the configuration and the run; a half-forgotten bus is worse. */
    suspend fun clearPairing() = edit {
        it.remove(KEY_DEVICE_ID)
        it.remove(KEY_INSTITUTION)
        it.remove(KEY_VEHICLE_ID)
        it.remove(KEY_VEHICLE_REGISTRATION)
        it.remove(KEY_PAUSED)
        it.remove(KEY_LAST_PUSH_AT)
        it.remove(KEY_LAST_HEARTBEAT_AT)
        it.remove(KEY_LAST_SERVER_ERROR)
        it.remove(KEY_TRIP_ID)
        it.remove(KEY_TRIP_ROUTE_ID)
        it.remove(KEY_TRIP_ROUTE_NAME)
        it.remove(KEY_TRIP_DIRECTION)
        it.remove(KEY_TRIP_STARTED_AT)
    }

    private fun readTrip(prefs: Preferences): ActiveTrip? {
        val id = prefs[KEY_TRIP_ID] ?: return null
        return ActiveTrip(
            tripId = id,
            routeId = prefs[KEY_TRIP_ROUTE_ID].orEmpty(),
            routeName = prefs[KEY_TRIP_ROUTE_NAME].orEmpty(),
            direction = prefs[KEY_TRIP_DIRECTION] ?: DIRECTION_PICKUP,
            startedAtMillis = prefs[KEY_TRIP_STARTED_AT] ?: 0L,
        )
    }

    private fun readRouteBook(prefs: Preferences): List<SavedRoute> {
        val raw = prefs[KEY_ROUTE_BOOK] ?: return emptyList()
        // A corrupted book is an empty book. Losing the driver's shortcuts is
        // recoverable; crashing on the screen that starts the run is not.
        return runCatching { json.decodeFromString<List<SavedRoute>>(raw) }.getOrDefault(emptyList())
    }

    private suspend fun edit(block: (MutablePreferences) -> Unit) {
        store.edit(block)
    }

    private companion object {
        val KEY_BASE_URL = stringPreferencesKey("base_url")
        val KEY_INSTITUTION = stringPreferencesKey("institution")
        val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        val KEY_VEHICLE_ID = stringPreferencesKey("vehicle_id")
        val KEY_VEHICLE_REGISTRATION = stringPreferencesKey("vehicle_registration")
        val KEY_PING_SECONDS = intPreferencesKey("ping_seconds")
        val KEY_PAUSED = booleanPreferencesKey("paused")
        val KEY_ALLOW_INSECURE = booleanPreferencesKey("allow_insecure_http")
        val KEY_LAST_PUSH_AT = longPreferencesKey("last_push_at")
        val KEY_LAST_HEARTBEAT_AT = longPreferencesKey("last_heartbeat_at")
        val KEY_LAST_SERVER_ERROR = stringPreferencesKey("last_server_error")
        val KEY_TRIP_ID = stringPreferencesKey("trip_id")
        val KEY_TRIP_ROUTE_ID = stringPreferencesKey("trip_route_id")
        val KEY_TRIP_ROUTE_NAME = stringPreferencesKey("trip_route_name")
        val KEY_TRIP_DIRECTION = stringPreferencesKey("trip_direction")
        val KEY_TRIP_STARTED_AT = longPreferencesKey("trip_started_at")
        val KEY_ROUTE_BOOK = stringPreferencesKey("route_book")
    }
}

const val DIRECTION_PICKUP = "pickup"
const val DIRECTION_DROP = "drop"

/**
 * A route the driver can pick by name.
 *
 * The wire contract has no device-facing endpoint that lists routes — the only
 * thing `POST /bus-tracker/trips` accepts is a `route_id` uuid — so the book is
 * filled in once, by whoever sets the phone up, and the driver picks from it
 * afterwards. Asking a driver to type a uuid at 6:40am is not a design; asking
 * them once, with someone from the office present, is the honest fallback until
 * the server offers a list.
 */
@Serializable
data class SavedRoute(
    val routeId: String,
    val label: String,
)

/** The run currently open, as far as this phone knows. */
data class ActiveTrip(
    val tripId: String,
    val routeId: String,
    val routeName: String,
    val direction: String,
    val startedAtMillis: Long,
)

data class TrackerSettings(
    val baseUrl: String,
    val institution: String?,
    val deviceId: String?,
    val vehicleId: String?,
    val vehicleRegistration: String?,
    val pingSeconds: Int,
    val paused: Boolean,
    val allowInsecureHttp: Boolean,
    val lastPushAt: Long,
    val lastHeartbeatAt: Long,
    val lastServerError: String?,
    val activeTrip: ActiveTrip?,
    val routeBook: List<SavedRoute>,
) {
    companion object {
        const val DEFAULT_PING_SECONDS = 20

        /** The contract's own range for `ping_seconds`. The phone never leaves it. */
        const val MIN_PING_SECONDS = 5
        const val MAX_PING_SECONDS = 300

        /**
         * A directive is clamped, not obeyed literally. The server is trusted to
         * own the cadence; it is not trusted to have been typed correctly, and a
         * zero would be a fix every millisecond and a flat battery by ten.
         */
        fun clampPing(value: Int): Int = value.coerceIn(MIN_PING_SECONDS, MAX_PING_SECONDS)
    }
}
