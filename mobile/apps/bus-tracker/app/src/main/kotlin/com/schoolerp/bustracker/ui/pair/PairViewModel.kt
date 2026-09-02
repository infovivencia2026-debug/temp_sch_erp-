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
    /* NOT THE DRIVER'S PROBLEM.
     *
       A driver gets a download link and the number and PIN the office issued
       him. He does not get told a URL, and he should not be shown a field he
       can only get wrong: every school on this deployment answers on the same
       host, and the sign-in resolves which school from his own PIN. So the
       address is compiled in and only a debug build lets anyone edit it. */
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
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
    /** Pair codes are a fallback for a bus with no driver assigned yet, and
     *  belong to whoever is debugging -- not to the man beside the bus. */
    val pairCodeAvailable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
    val baseUrlEditable: Boolean = BuildConfig.ALLOW_INSECURE_HTTP,
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
            else -> phone.isNotBlank() && pin.isNotEmpty()
        }
}

@HiltViewModel
class PairViewModel @Inject constructor(
    private val repository: TrackerRepository,
    private val settingsStore: SettingsStore,
    private val engine: com.schoolerp.bustracker.engine.TripEngine,
) : ViewModel() {

    private val _state = MutableStateFlow(PairUiState())
    val state: StateFlow<PairUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val settings = settingsStore.settings.first()
            _state.value = _state.value.copy(
                /* THE BUILD WINS, NOT THE STORED VALUE.

                   This kept a stored address and fell back to the compiled one
                   only when it was blank, which sounds conservative and is the
                   opposite. App data survives a reinstall, so a handset that
                   was paired before this build kept whatever address was typed
                   into it weeks ago, forever, against a build that no longer
                   shows the field to change it. Measured on a real phone: the
                   sign-in was refused and the request never reached the server
                   at all.

                   A release build has exactly one correct address and it is
                   the one it was compiled with. Only a debug build, which is
                   the only build that can still edit the field, keeps what it
                   was given. */
                baseUrl = if (BuildConfig.ALLOW_INSECURE_HTTP) {
                    settings.baseUrl.ifBlank { BuildConfig.DEFAULT_BASE_URL }
                } else {
                    BuildConfig.DEFAULT_BASE_URL
                },
                allowInsecureHttp = settings.allowInsecureHttp,
                /* WHY THIS SCREEN IS BACK.
                 *
                   A token the office retired mid-run drops the driver here
                   with no account of itself, and a blank sign-in form after a
                   run that was working reads as the app having lost its mind.
                   The reason was written down when the pairing was cleared,
                   precisely so it could be said here. */
                error = settings.signedOutReason,
            )
        }
    }

    fun onBaseUrlChanged(value: String) {
        _state.value = _state.value.copy(baseUrl = value, error = null)
    }

    /* NOT ONLY A PHONE NUMBER.
     *
       This stripped everything that was not a digit and cut the result to ten,
       because the credential used to be a phone and a PIN. But HR issues a
       login, and a login is often an email address -- which this silently
       deleted down to whatever digits it happened to contain, then refused to
       submit at all because the result was not ten characters long.

       The server matches email, username or phone, so accept what the office
       actually wrote on the slip. */
    fun onPhoneChanged(value: String) {
        _state.value = _state.value.copy(phone = value.trim().take(120), error = null)
    }

    /* NOT DIGITS ANY MORE.
     *
       This is the driver's ordinary login password, so it can contain anything
       a password contains. Stripping non-digits here -- which is what this did
       when the credential was a four-digit PIN -- silently deleted most of a
       real password and then reported that it did not match. */
    fun onPinChanged(value: String) {
        _state.value = _state.value.copy(pin = value.take(72), error = null)
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
                is PairOutcome.Paired -> {
                    /* The engine stops every loop for good when the server
                       rejects a token, and nothing cleared that. A driver who
                       was signed out by the office and then signed in again
                       would report nothing at all until the app was
                       force-stopped, with a screen that said he was signed in.
                       A fresh pairing is exactly the event that makes the old
                       rejection stale. */
                    engine.credentialAccepted()
                    _state.value = _state.value.copy(
                        submitting = false,
                        pairedVehicle = outcome.vehicleRegistration,
                        pairedInstitution = outcome.institution,
                        pairCode = "",
                        // Whatever the last pairing was thrown out for has
                        // just been answered by this one.
                        error = null,
                    )
                }
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
    /** The driver read the registration and it is their bus. */
    fun confirmVehicle() {
        _state.value = _state.value.copy(pairedVehicle = null, pairedInstitution = null)
        repository.confirmPairing()
    }

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
