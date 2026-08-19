package com.schoolerp.bustracker.ui.pair

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.bustracker.BuildConfig
import com.schoolerp.bustracker.core.PairCode
import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.repo.PairOutcome
import com.schoolerp.bustracker.data.repo.TrackerRepository
import dagger.hilt.android.lifecycle.HiltViewModel
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
    /** The registration the server echoed back. Shown before anything reports. */
    val pairedVehicle: String? = null,
    val pairedInstitution: String? = null,
    val allowInsecureHttp: Boolean = false,
    /** The plain-HTTP switch is only offered at all in a debug build. */
    val insecureToggleAvailable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
) {
    val canSubmit: Boolean
        get() = !submitting && baseUrl.isNotBlank() && PairCode.isComplete(pairCode)
}

@HiltViewModel
class PairViewModel @Inject constructor(
    private val repository: TrackerRepository,
    private val settingsStore: SettingsStore,
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
                is PairOutcome.Paired -> _state.value = _state.value.copy(
                    submitting = false,
                    pairedVehicle = outcome.vehicleRegistration,
                    pairedInstitution = outcome.institution,
                    pairCode = "",
                )
                is PairOutcome.Rejected ->
                    _state.value = _state.value.copy(submitting = false, error = outcome.message)
            }
        }
    }

    /**
     * The driver said the registration is not their bus. Undo the pairing here
     * and now, rather than leave a phone reporting as the wrong vehicle until
     * someone in the office notices two buses on one street.
     */
    fun rejectVehicle() {
        viewModelScope.launch {
            repository.unpair()
            _state.value = _state.value.copy(
                pairedVehicle = null,
                pairedInstitution = null,
                error = "Unpaired. Ask the office for a code for the right bus.",
            )
        }
    }
}
