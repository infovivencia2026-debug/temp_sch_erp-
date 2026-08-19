package com.schoolerp.smsgateway.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore("gateway_settings")

/**
 * Everything about the pairing except the credential. Plain DataStore is the
 * right home for this — it is configuration, not secrets — and the token
 * deliberately lives elsewhere, in [TokenStore].
 */
@Singleton
class SettingsStore @Inject constructor(
    @param:dagger.hilt.android.qualifiers.ApplicationContext private val context: Context,
) {

    private val store get() = context.settingsDataStore

    val settings: Flow<GatewaySettings> = store.data.map { prefs ->
        GatewaySettings(
            baseUrl = prefs[KEY_BASE_URL].orEmpty(),
            institutionName = prefs[KEY_INSTITUTION_NAME],
            institutionId = prefs[KEY_INSTITUTION_ID],
            deviceId = prefs[KEY_DEVICE_ID],
            pollSeconds = prefs[KEY_POLL_SECONDS] ?: GatewaySettings.DEFAULT_POLL_SECONDS,
            maxPerMinute = prefs[KEY_MAX_PER_MINUTE] ?: GatewaySettings.DEFAULT_MAX_PER_MINUTE,
            pausedByServer = prefs[KEY_PAUSED] ?: false,
            allowInsecureHttp = prefs[KEY_ALLOW_INSECURE] ?: false,
            lastPollAt = prefs[KEY_LAST_POLL_AT] ?: 0L,
            lastHeartbeatAt = prefs[KEY_LAST_HEARTBEAT_AT] ?: 0L,
            lastServerError = prefs[KEY_LAST_SERVER_ERROR],
        )
    }

    suspend fun setBaseUrl(url: String) = edit { it[KEY_BASE_URL] = url }

    suspend fun setAllowInsecureHttp(allow: Boolean) = edit { it[KEY_ALLOW_INSECURE] = allow }

    suspend fun recordPairing(deviceId: String, institutionId: String?, institutionName: String) =
        edit {
            it[KEY_DEVICE_ID] = deviceId
            it[KEY_INSTITUTION_NAME] = institutionName
            if (institutionId != null) it[KEY_INSTITUTION_ID] = institutionId
        }

    /** The server owns the cadence. The phone stores what it was told, clamped. */
    suspend fun applyServerDirectives(pollSeconds: Int?, paused: Boolean?, maxPerMinute: Int?) =
        edit { prefs ->
            pollSeconds?.let { prefs[KEY_POLL_SECONDS] = it.coerceIn(GatewaySettings.MIN_POLL_SECONDS, GatewaySettings.MAX_POLL_SECONDS) }
            paused?.let { prefs[KEY_PAUSED] = it }
            maxPerMinute?.let { prefs[KEY_MAX_PER_MINUTE] = it.coerceIn(1, GatewaySettings.MAX_ALLOWED_PER_MINUTE) }
        }

    suspend fun recordPoll(at: Long, error: String?) = edit {
        it[KEY_LAST_POLL_AT] = at
        if (error == null) it.remove(KEY_LAST_SERVER_ERROR) else it[KEY_LAST_SERVER_ERROR] = error
    }

    suspend fun recordHeartbeat(at: Long) = edit { it[KEY_LAST_HEARTBEAT_AT] = at }

    /** Unpairing wipes the configuration too; a half-forgotten school is worse. */
    suspend fun clearPairing() = edit {
        it.remove(KEY_DEVICE_ID)
        it.remove(KEY_INSTITUTION_ID)
        it.remove(KEY_INSTITUTION_NAME)
        it.remove(KEY_PAUSED)
        it.remove(KEY_LAST_POLL_AT)
        it.remove(KEY_LAST_HEARTBEAT_AT)
        it.remove(KEY_LAST_SERVER_ERROR)
    }

    private suspend fun edit(block: (androidx.datastore.preferences.core.MutablePreferences) -> Unit) {
        store.edit(block)
    }

    private companion object {
        val KEY_BASE_URL = stringPreferencesKey("base_url")
        val KEY_INSTITUTION_NAME = stringPreferencesKey("institution_name")
        val KEY_INSTITUTION_ID = stringPreferencesKey("institution_id")
        val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        val KEY_POLL_SECONDS = intPreferencesKey("poll_seconds")
        val KEY_MAX_PER_MINUTE = intPreferencesKey("max_per_minute")
        val KEY_PAUSED = booleanPreferencesKey("paused")
        val KEY_ALLOW_INSECURE = booleanPreferencesKey("allow_insecure_http")
        val KEY_LAST_POLL_AT = longPreferencesKey("last_poll_at")
        val KEY_LAST_HEARTBEAT_AT = longPreferencesKey("last_heartbeat_at")
        val KEY_LAST_SERVER_ERROR = stringPreferencesKey("last_server_error")
    }
}

data class GatewaySettings(
    val baseUrl: String,
    val institutionName: String?,
    val institutionId: String?,
    val deviceId: String?,
    val pollSeconds: Int,
    val maxPerMinute: Int,
    val pausedByServer: Boolean,
    val allowInsecureHttp: Boolean,
    val lastPollAt: Long,
    val lastHeartbeatAt: Long,
    val lastServerError: String?,
) {
    companion object {
        const val DEFAULT_POLL_SECONDS = 30
        const val MIN_POLL_SECONDS = 5
        const val MAX_POLL_SECONDS = 900

        /**
         * The contract says the server sets a per-minute cap but gives it no
         * field on the wire, so until it does the phone applies a deliberately
         * timid default. Ten a minute is well inside every Indian carrier's
         * tolerance for a personal SIM and still clears a few hundred messages
         * in an hour.
         */
        const val DEFAULT_MAX_PER_MINUTE = 10
        const val MAX_ALLOWED_PER_MINUTE = 60
    }
}
