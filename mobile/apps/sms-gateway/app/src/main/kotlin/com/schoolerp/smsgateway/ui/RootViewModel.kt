package com.schoolerp.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.engine.GatewayEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class RootViewModel @Inject constructor(
    repository: GatewayRepository,
    private val engine: GatewayEngine,
) : ViewModel() {

    /** Paired, and past the card that reads the school's name back. */
    val paired: StateFlow<Boolean> =
        combine(repository.paired, repository.awaitingConfirmation) { paired, confirming -> paired && !confirming }
            .stateIn(viewModelScope, SharingStarted.Eagerly, repository.paired.value && !repository.awaitingConfirmation.value)

    /** After a permission dialog closes, the answer has to reach the status screen. */
    fun refreshDeviceSnapshot() = engine.refreshDeviceSnapshot()
}
