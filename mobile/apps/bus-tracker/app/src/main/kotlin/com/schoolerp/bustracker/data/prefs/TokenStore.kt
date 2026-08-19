package com.schoolerp.bustracker.data.prefs

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.MasterKey
import com.schoolerp.bustracker.core.BtLog
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The device token, and nothing else.
 *
 * It lives in [EncryptedSharedPreferences] — backed by a keystore-held master
 * key — rather than in DataStore, because DataStore's file is plaintext on
 * disk and the token is the single credential that lets anything speak for
 * this bus. The token is not only a credential: anything holding it can file
 * positions in a school bus's name, and the phone it lives on is a driver's
 * personal handset that goes home, gets lent, and gets sold.
 *
 * Jetpack Security Crypto is deprecated with no AndroidX successor. The
 * alternative is hand-rolled `KeyStore` and `Cipher` code, which is a worse
 * thing for a school's app to own than a deprecated library that still does
 * exactly what it says. The deprecation is suppressed here, in the one file
 * that touches it, so that the day a replacement arrives there is a single
 * place to change.
 */
@Suppress("DEPRECATION")
@Singleton
class TokenStore @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    private val prefs: SharedPreferences by lazy { open() }

    private val _paired = MutableStateFlow(false)

    /** True once a token exists. Drives the pair-screen / run-screen choice. */
    val paired: StateFlow<Boolean> = _paired.asStateFlow()

    init {
        _paired.value = runCatching { prefs.contains(KEY_TOKEN) }.getOrDefault(false)
    }

    fun token(): String? = runCatching { prefs.getString(KEY_TOKEN, null) }.getOrNull()

    fun deviceId(): String? = runCatching { prefs.getString(KEY_DEVICE_ID, null) }.getOrNull()

    fun save(deviceId: String, token: String) {
        // commit(), not apply(): the very next thing that happens is the
        // service starting and reading this token back.
        prefs.edit(commit = true) {
            putString(KEY_DEVICE_ID, deviceId)
            putString(KEY_TOKEN, token)
        }
        _paired.value = true
        BtLog.i("token", "stored credential for device $deviceId")
    }

    /**
     * Called when the server rejects the token, or when the operator unpairs.
     * After this the app is inert until someone types a new pair code.
     */
    fun clear() {
        runCatching { prefs.edit(commit = true) { clear() } }
        _paired.value = false
        BtLog.i("token", "credential cleared; device is unpaired")
    }

    private fun open(): SharedPreferences =
        try {
            create()
        } catch (first: Exception) {
            // A keystore key can be lost outright — a security-patch migration,
            // a lock-screen change on some OEM builds, a restored backup. The
            // ciphertext is then unreadable for ever, so the only honest move is
            // to throw the file away and make the operator re-pair, rather than
            // crash-loop on every launch.
            BtLog.w("token", "encrypted store unreadable, discarding and re-pairing", first)
            context.deleteSharedPreferences(FILE_NAME)
            create()
        }

    private fun create(): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private companion object {
        const val FILE_NAME = "tracker_credential"
        const val KEY_TOKEN = "device_token"
        const val KEY_DEVICE_ID = "device_id"
    }
}
