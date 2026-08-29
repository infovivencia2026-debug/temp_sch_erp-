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
    /* THE ORDINARY WAY IN.
     *
     * A pair code needs somebody in the office at the moment the driver is
     * standing beside the bus, which is six in the morning. HR already records
     * who drives which bus, so the number and the PIN the office issued are
     * enough on their own and the server answers with the vehicle.
     *
     * The pair code stays as the second option, for a bus with no driver
     * assigned yet and for schools already using codes. */
    val phone: String = "",
    val pin: String = "",
    val usePairCode: Boolean = false,
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
        get() = !submitting && baseUrl.isNotBlank() && when {
            usePairCode -> PairCode.isComplete(pairCode)
            // The server's own shape, so an obviously wrong entry never
            // becomes a failed attempt counting towards the PIN lockout.
            else -> phone.length == 10 && pin.length >= 4
        }
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

    fun onPhoneChanged(value: String) {
        _state.value = _state.value.copy(phone = value.filter(Char::isDigit).take(10), error = null)
    }

    fun onPinChanged(value: String) {
        _state.value = _state.value.copy(pin = value.filter(Char::isDigit).take(6), error = null)
    }

    fun usePairCode(on: Boolean) {
        _state.value = _state.value.copy(usePairCode = on, error = null)
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
            val outcome = if (current.usePairCode) {
                repository.pair(current.baseUrl, current.pairCode)
            } else {
                repository.driverSignIn(current.baseUrl, current.phone, current.pin)
            }
            when (outcome) {
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
