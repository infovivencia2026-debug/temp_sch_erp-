package com.schoolerp.bustracker.device

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import com.schoolerp.bustracker.core.BtLog
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Everything the heartbeat reports about the handset, and everything the run
 * screen needs to answer "why is the school not seeing us".
 *
 * Every reader degrades to a null or a false rather than throwing. A tracker
 * that crashes because it could not read a battery level is worse than one
 * that reports an unknown battery.
 */
@Singleton
class DeviceStatusProvider @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    fun batteryPct(): Int = runCatching {
        context.getSystemService(BatteryManager::class.java)
            ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }.getOrDefault(-1).let { if (it in 0..100) it else -1 }

    fun charging(): Boolean = runCatching {
        val status: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        when (status?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            else -> false
        }
    }.getOrDefault(false)

    fun hasNetwork(): Boolean = runCatching {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }.getOrDefault(false)

    fun notificationsAllowed(): Boolean =
        runCatching { NotificationManagerCompat.from(context).areNotificationsEnabled() }
            .getOrDefault(true)

    /**
     * A location foreground service is exempt from Doze while it runs, so this
     * is not what keeps the fixes coming. It is what keeps them *evenly spaced*:
     * without the exemption, an OEM battery manager on a phone lying still on a
     * dashboard throttles the app anyway, and the map shows a bus that jumps a
     * kilometre at a time. The app asks for it from the run screen with an
     * explanation; it never asks silently.
     */
    fun ignoringBatteryOptimisations(): Boolean = runCatching {
        context.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(context.packageName) ?: false
    }.getOrDefault(false)

    fun appVersion(): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
    }.getOrElse {
        BtLog.w("device", "could not read own version")
        "unknown"
    }

    fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun deviceModel(): String = Build.MODEL.orEmpty().ifBlank { "unknown" }

    fun androidVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
}
