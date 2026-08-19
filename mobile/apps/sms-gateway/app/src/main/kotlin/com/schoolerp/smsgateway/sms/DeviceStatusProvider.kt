package com.schoolerp.smsgateway.sms

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.telephony.TelephonyManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.schoolerp.smsgateway.core.GwLog
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Everything the heartbeat reports and everything the status screen needs to
 * answer "why is nothing sending".
 *
 * Every reader here degrades to a null or a false rather than throwing. A
 * gateway that crashes because it could not read a signal strength is worse
 * than one that reports an unknown signal.
 */
@Singleton
class DeviceStatusProvider @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {

    private val telephony: TelephonyManager?
        get() = context.getSystemService(TelephonyManager::class.java)

    fun simReady(): Boolean =
        runCatching { telephony?.simState == TelephonyManager.SIM_STATE_READY }.getOrDefault(false)

    fun simOperator(): String? =
        runCatching { telephony?.simOperatorName?.takeIf { it.isNotBlank() } }.getOrNull()

    fun hasPhoneStatePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Null when the permission was refused or the platform is too old. The
     * heartbeat then omits `signal_dbm`, which is honest; the alternative — an
     * invented number — would have the admin screen show a healthy bar for a
     * phone sitting in a basement.
     */
    fun signalDbm(): Int? {
        if (!hasPhoneStatePermission()) return null
        // getCellSignalStrengths is API 29; below that the heartbeat simply
        // omits the field rather than reporting a number it cannot read.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return runCatching {
            telephony?.signalStrength?.cellSignalStrengths
                ?.firstOrNull { it.dbm != Int.MAX_VALUE }?.dbm
        }.getOrNull()
    }

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
     * Without this exemption Doze suspends the polling loop on a handset that
     * has been still in a drawer for an hour, which is exactly the handset this
     * app runs on. The app asks for it from the status screen with an
     * explanation; it never asks silently.
     */
    fun ignoringBatteryOptimisations(): Boolean = runCatching {
        context.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(context.packageName) ?: false
    }.getOrDefault(false)

    fun appVersion(): String = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        info.versionName ?: "unknown"
    }.getOrElse {
        GwLog.w("device", "could not read own version")
        "unknown"
    }

    fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun androidVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
}
