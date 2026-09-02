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
    /* The address is compiled in and only a debug build may edit it. The
       office types a login, not a URL: a typo in a hostname fails exactly like
       a wrong password, and app data outlives the build that asked for it. */
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val baseUrlEditable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
    val phone: String = "",
    val password: String = "",
    /** Pair codes are the fallback, and belong to whoever is debugging. */
    /* The code is the way in, and the office login is the fallback.
       A clerk pairing the office handset has a nine-digit code on the admin
       screen in front of them. Asking them for an email and a password first
       -- credentials that belong to a person rather than to the phone -- put
       the harder route in front of the easier one. */
    val usePairCode: Boolean = true,
    val pairCodeAvailable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
    val pairCode: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    val pairedTo: String? = null,
    val allowInsecureHttp: Boolean = false,
    /** The plain-HTTP switch is only offered at all in a debug build. */
    val insecureToggleAvailable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
) {
    val canSubmit: Boolean
        get() = !submitting && baseUrl.isNotBlank() && when {
            usePairCode -> PairCode.isComplete(pairCode)
            else -> phone.isNotBlank() && password.isNotEmpty()
        }
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
                baseUrl = if (BuildConfig.ALLOW_INSECURE_HTTP) {
                    settings.baseUrl.ifBlank { BuildConfig.DEFAULT_BASE_URL }
                } else {
                    BuildConfig.DEFAULT_BASE_URL
                },
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

    fun onPhoneChanged(value: String) {
        _state.value = _state.value.copy(phone = value.trim().take(120), error = null)
    }

    fun onPasswordChanged(value: String) {
        _state.value = _state.value.copy(password = value.take(72), error = null)
    }

    fun usePairCode(on: Boolean) {
        _state.value = _state.value.copy(usePairCode = on, error = null)
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
            val outcome =
                if (current.usePairCode) repository.pair(current.baseUrl, current.pairCode)
                else repository.enrol(current.baseUrl, current.phone, current.password)
            when (outcome) {
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
        repository.confirmPairing()
    }
}
