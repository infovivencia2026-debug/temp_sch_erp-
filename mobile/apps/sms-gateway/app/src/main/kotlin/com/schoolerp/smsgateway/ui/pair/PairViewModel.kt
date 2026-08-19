package com.schoolerp.smsgateway.ui.pair

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.smsgateway.BuildConfig
import com.schoolerp.smsgateway.core.PairCode
import com.schoolerp.smsgateway.data.prefs.SettingsStore
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.data.repo.PairOutcome
import com.schoolerp.smsgateway.service.GatewayServiceLauncher
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PairUiState(
    val baseUrl: String = "",
    val pairCode: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    val pairedTo: String? = null,
    val allowInsecureHttp: Boolean = false,
    /** The plain-HTTP switch is only offered at all in a debug build. */
    val insecureToggleAvailable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
) {
    val canSubmit: Boolean
        get() = !submitting && baseUrl.isNotBlank() && PairCode.isComplete(pairCode)
}

@HiltViewModel
class PairViewModel @Inject constructor(
    private val repository: GatewayRepository,
    private val settingsStore: SettingsStore,
    @param:ApplicationContext private val context: Context,
) : ViewModel() {

    private val _state = MutableStateFlow(PairUiState())
    val state: StateFlow<PairUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val settings = settingsStore.settings.first()
            _state.value = _state.value.copy(
                baseUrl = settings.baseUrl,
                allowInsecureHttp = settings.allowInsecureHttp,
            )
        }
    }

    fun onBaseUrlChanged(value: String) {
        _state.value = _state.value.copy(baseUrl = value, error = null)
    }

    fun onPairCodeChanged(value: String) {
        _state.value = _state.value.copy(pairCode = PairCode.normalise(value), error = null)
    }

    fun onAllowInsecureChanged(allow: Boolean) {
        _state.value = _state.value.copy(allowInsecureHttp = allow)
        viewModelScope.launch { settingsStore.setAllowInsecureHttp(allow) }
    }

    fun pair() {
        val current = _state.value
        if (!current.canSubmit) return
        _state.value = current.copy(submitting = true, error = null)

        viewModelScope.launch {
            when (val outcome = repository.pair(current.baseUrl, current.pairCode)) {
                is PairOutcome.Paired -> {
                    _state.value = _state.value.copy(
                        submitting = false,
                        pairedTo = outcome.institutionName,
                        pairCode = "",
                    )
                    // Nothing is claimed until the loop is running.
                    GatewayServiceLauncher.start(context)
                }
                is PairOutcome.Rejected ->
                    _state.value = _state.value.copy(submitting = false, error = outcome.message)
            }
        }
    }

    fun dismissConfirmation() {
        _state.value = _state.value.copy(pairedTo = null)
    }
}
