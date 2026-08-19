package com.schoolerp.smsgateway.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.data.prefs.TokenStore
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * A power cut at 6am must not mean no absence messages at 9am.
 *
 * `BOOT_COMPLETED` is one of the few remaining exemptions that permits starting
 * a foreground service from the background, which is exactly what is needed
 * here. `MY_PACKAGE_REPLACED` covers the other case: an app update stops the
 * service and nothing would otherwise restart it.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var tokenStore: TokenStore

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }
        if (tokenStore.token() == null) {
            GwLog.i("boot", "not paired; staying idle")
            return
        }
        GwLog.i("boot", "restarting gateway after ${intent.action}")
        GatewayServiceLauncher.start(context)
    }
}
