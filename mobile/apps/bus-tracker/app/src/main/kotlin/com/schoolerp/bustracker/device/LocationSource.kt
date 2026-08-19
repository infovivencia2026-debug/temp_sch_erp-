package com.schoolerp.bustracker.device

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import com.schoolerp.bustracker.core.BtLog
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import javax.inject.Inject
import javax.inject.Singleton

/** One fix, in the units the wire wants. */
data class Fix(
    val atMillis: Long,
    val latitude: Double,
    val longitude: Double,
    val speedKmph: Double?,
    val headingDeg: Int?,
    val accuracyM: Double?,
)

/**
 * Fixes, from the platform's own [LocationManager].
 *
 * Deliberately not Google Play Services' fused provider. That would be a new
 * dependency and a hard requirement on a Play-certified handset, and the phones
 * this app runs on are whatever the driver already owns — including the ones
 * sold in India with no Play Services at all. The fused provider would give
 * slightly smoother fixes; a bus that cannot be tracked because the driver's
 * phone is not Google-blessed is a worse trade.
 */
@Singleton
class LocationSource @Inject constructor(
    @param:ApplicationContext private val context: Context,
    private val permissions: LocationPermissions,
) {

    private val manager: LocationManager?
        get() = context.getSystemService(LocationManager::class.java)

    /**
     * Emits until cancelled. [intervalSeconds] is the server's `ping_seconds`,
     * passed to the OS as the requested interval so the radio can sleep between
     * fixes — asking for continuous updates and throwing most away is how a
     * tracking app flattens a battery before lunch.
     *
     * The permission is checked on every subscription rather than once at
     * construction, because a driver can revoke it from Settings mid-route and
     * the flow has to end honestly rather than go silent.
     */
    @SuppressLint("MissingPermission")
    fun fixes(intervalSeconds: Int): Flow<Fix> = callbackFlow {
        val lm = manager
        if (lm == null || !permissions.hasFine()) {
            BtLog.w("location", "no provider or no fine-location grant; emitting nothing")
            close()
            return@callbackFlow
        }

        val listener = LocationListener { location -> trySend(location.toFix()) }

        val intervalMillis = intervalSeconds.coerceAtLeast(1) * 1_000L
        val providers = providersToUse(lm)
        if (providers.isEmpty()) {
            BtLog.w("location", "no enabled provider")
            close()
            return@callbackFlow
        }

        providers.forEach { provider ->
            runCatching {
                lm.requestLocationUpdates(
                    provider,
                    intervalMillis,
                    // No minimum distance. A bus stationary at a stop for ten
                    // minutes must still report, or the office cannot tell it
                    // apart from a phone that has stopped working.
                    0f,
                    listener,
                    Looper.getMainLooper(),
                )
            }.onFailure { BtLog.w("location", "could not subscribe to $provider", it) }
        }

        awaitClose {
            runCatching { lm.removeUpdates(listener) }
        }
    }

    /**
     * GPS first, and the network provider alongside it only as a stand-in while
     * the GPS gets its first lock — a bus under a flyover at 6:40am otherwise
     * shows nothing at all for the first two minutes of the run. Network fixes
     * carry their real (large) accuracy, and everything downstream widens or
     * refuses a geofence on that number rather than trusting the coordinate.
     */
    private fun providersToUse(lm: LocationManager): List<String> = buildList {
        if (runCatching { lm.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false)) {
            add(LocationManager.GPS_PROVIDER)
        }
        if (runCatching { lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false)) {
            add(LocationManager.NETWORK_PROVIDER)
        }
    }

    private fun Location.toFix(): Fix = Fix(
        atMillis = time,
        latitude = latitude,
        longitude = longitude,
        // The platform reports metres per second; the contract wants km/h.
        speedKmph = if (hasSpeed()) speed * 3.6 else null,
        // A heading from a stationary phone is noise, so it is dropped rather
        // than sent as an arrow pointing somewhere the bus is not going.
        headingDeg = if (hasBearing() && hasSpeed() && speed > MIN_SPEED_FOR_HEADING_MPS) {
            bearing.toInt().mod(360)
        } else {
            null
        },
        accuracyM = if (hasAccuracy()) accuracy.toDouble() else null,
    )

    private companion object {
        /** Below walking pace the bearing is jitter, not a direction of travel. */
        const val MIN_SPEED_FOR_HEADING_MPS = 1.0f
    }
}
