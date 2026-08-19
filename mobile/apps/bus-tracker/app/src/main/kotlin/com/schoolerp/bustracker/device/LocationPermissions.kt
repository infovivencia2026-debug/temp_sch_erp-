package com.schoolerp.bustracker.device

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * What the OS is actually granting, as opposed to what the app asked for.
 *
 * This is the source of `location_ok` on the heartbeat, and it is deliberately
 * pessimistic. The failure this app exists to make visible is the healthy-
 * looking one: charged, online, permission "granted" in the app's own memory,
 * and the OS quietly not delivering a single fix because background location
 * was downgraded to while-in-use, or because the driver switched Location off
 * at the quick-settings tile.
 */
@Singleton
class LocationPermissions @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    fun hasFine(): Boolean = granted(Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasCoarse(): Boolean = granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    /**
     * Below API 29 there is no separate background grant: foreground location
     * kept working with the screen off, and asking for a permission that does
     * not exist would return false forever and report a healthy phone as sick.
     */
    fun hasBackground(): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            hasFine() || hasCoarse()
        } else {
            granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }

    /** The system-wide Location switch, which no permission grant overrides. */
    fun locationServicesOn(): Boolean = runCatching {
        context.getSystemService(LocationManager::class.java)?.isLocationEnabled ?: false
    }.getOrDefault(false)

    /**
     * `location_ok` on the wire.
     *
     * All three have to hold. Only fine location is good enough to say which
     * side of a stop a bus is on; a coarse-only grant is reported as not OK,
     * because a cell-tower fix on the office map is a bus in the wrong street,
     * which is worse than a bus that is honestly missing.
     */
    fun locationOk(): Boolean = hasFine() && hasBackground() && locationServicesOn()

    /** Why not, in the driver's words. Null when everything is in order. */
    fun blocker(): LocationBlocker? = when {
        !hasFine() && !hasCoarse() -> LocationBlocker.NO_PERMISSION
        !hasFine() -> LocationBlocker.APPROXIMATE_ONLY
        !hasBackground() -> LocationBlocker.FOREGROUND_ONLY
        !locationServicesOn() -> LocationBlocker.LOCATION_OFF
        else -> null
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

enum class LocationBlocker(val headline: String, val detail: String) {
    NO_PERMISSION(
        "Location is not allowed",
        "The school cannot see this bus at all. Allow location for this app.",
    ),
    APPROXIMATE_ONLY(
        "Only approximate location is allowed",
        "The bus would show in roughly the right area, which is not good enough to " +
            "tell a parent it has reached their stop. Switch on precise location.",
    ),
    FOREGROUND_ONLY(
        "Location stops when the screen is off",
        "Choose \"Allow all the time\". Without it the bus disappears from the map " +
            "the moment you put the phone down, which is most of the run.",
    ),
    LOCATION_OFF(
        "Location is switched off on this phone",
        "Turn Location on in quick settings. No permission can work around this.",
    ),
}
