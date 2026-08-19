package com.schoolerp.smsgateway.ui.status

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.engine.GatewayEngine
import com.schoolerp.smsgateway.engine.GatewayStatus
import com.schoolerp.smsgateway.engine.StatusAggregator
import com.schoolerp.smsgateway.service.GatewayServiceLauncher
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class StatusViewModel @Inject constructor(
    aggregator: StatusAggregator,
    private val engine: GatewayEngine,
    private val repository: GatewayRepository,
    @param:ApplicationContext private val context: Context,
) : ViewModel() {

    val status: StateFlow<GatewayStatus> = aggregator.status
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), GatewayStatus())

    /**
     * Permissions can be revoked from Settings while the app is in the
     * background, so the snapshot is re-read every time this screen resumes
     * rather than only on the engine's timer.
     */
    fun refresh() = engine.refreshDeviceSnapshot()

    fun startService() = GatewayServiceLauncher.start(context)

    fun stopService() = GatewayServiceLauncher.stop(context)

    fun unpair() {
        viewModelScope.launch {
            repository.unpair()
            GatewayServiceLauncher.stop(context)
        }
    }

    fun openAppSettings(): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun openNotificationSettings(): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * The system dialog that asks, in as many words, whether this app may
     * ignore battery optimisation. It is only ever reached from a button the
     * operator pressed, next to an explanation of what it buys.
     */
    @SuppressLint("BatteryLife")
    fun requestBatteryExemption(): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData("package:${context.packageName}".toUri())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
