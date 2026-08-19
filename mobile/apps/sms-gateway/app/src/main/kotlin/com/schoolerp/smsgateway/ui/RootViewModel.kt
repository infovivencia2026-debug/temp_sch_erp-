package com.schoolerp.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.engine.GatewayEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class RootViewModel @Inject constructor(
    repository: GatewayRepository,
    private val engine: GatewayEngine,
) : ViewModel() {

    val paired: StateFlow<Boolean> =
        repository.paired.stateIn(viewModelScope, SharingStarted.Eagerly, repository.paired.value)

    /** After a permission dialog closes, the answer has to reach the status screen. */
    fun refreshDeviceSnapshot() = engine.refreshDeviceSnapshot()
}
