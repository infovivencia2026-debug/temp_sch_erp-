package com.schoolerp.bustracker.ui.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.core.PairCode
import com.schoolerp.bustracker.ui.theme.BusType
import com.schoolerp.bustracker.ui.theme.CodeBoxes
import com.schoolerp.bustracker.ui.theme.ErrorSentence
import com.schoolerp.bustracker.ui.theme.ListRow
import com.schoolerp.bustracker.ui.theme.OfficeHelp
import com.schoolerp.bustracker.ui.theme.PrimaryButton
import com.schoolerp.bustracker.ui.theme.QuietLink
import com.schoolerp.bustracker.ui.theme.SectionLabel

/* THE FIRST SCREEN, AT TEN TO SEVEN.

   Two fields and one button. The number goes on a phone keypad, the PIN into
   six boxes on the same keypad, and the button is the whole width of the
   screen at the bottom where a thumb already is. What went wrong is one
   sentence in the warning colour, followed by who to ring.

   The rarer ways in -- an email login with a long password, and the office's
   six-digit pairing code for a bus nobody is assigned to yet -- are each one
   quiet line under the button, never a second form on the same screen.

   Nothing the view model does has changed: the same fields, the same
   `canSubmit`, the same three branches in `pair()`. */
@Composable
fun PairScreen(viewModel: PairViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // Screen-only: which keyboard the login wants. The view model accepts
    // either shape and the server matches email, username or phone.
    var emailLogin by rememberSaveable { mutableStateOf(false) }

    val choosingBus = state.buses.isNotEmpty()

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            if (!choosingBus) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .imePadding()
                        .padding(horizontal = 20.dp)
                        .padding(bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    PrimaryButton(
                        text = stringResource(if (state.usePairCode) R.string.pair_button else R.string.signin_button),
                        onClick = viewModel::pair,
                        enabled = state.canSubmit,
                        busy = state.submitting,
                    )
                    if (state.pairCodeAvailable) {
                        QuietLink(
                            text = stringResource(
                                if (state.usePairCode) R.string.pair_switch_to_signin else R.string.pair_switch_to_code,
                            ),
                            onClick = { viewModel.usePairCode(!state.usePairCode) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        },
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                stringResource(
                    when {
                        choosingBus -> R.string.choose_bus_title
                        state.usePairCode -> R.string.pair_title
                        else -> R.string.signin_title
                    },
                ),
                style = BusType.display,
            )

            when {
                /* Signed in, and the office has not said which bus. He is
                   standing next to it: the registration is what he reads off
                   the back, so it is the row's title. */
                choosingBus -> {
                    state.buses.forEach { bus ->
                        val detail = listOf(bus.model, bus.busCode).filter { it.isNotBlank() }
                        ListRow(
                            title = bus.registrationNo,
                            subtitle = detail.takeIf { it.isNotEmpty() }?.joinToString(" · "),
                            enabled = !state.submitting,
                            onClick = { viewModel.chooseBus(bus.id) },
                        )
                    }
                }

                state.usePairCode -> {
                    SectionLabel(stringResource(R.string.pair_code_hint))
                    CodeBoxes(
                        value = state.pairCode,
                        onValueChange = { viewModel.onPairCodeChanged(PairCode.normalise(it)) },
                        label = stringResource(R.string.pair_code_label),
                        onDone = { if (state.canSubmit) viewModel.pair() },
                    )
                }

                else -> {
                    DriverCredentials(
                        phone = state.phone,
                        onPhoneChanged = viewModel::onPhoneChanged,
                        pin = state.pin,
                        onPinChanged = viewModel::onPinChanged,
                        emailLogin = emailLogin,
                        onEmailLoginChanged = { emailLogin = it },
                        onDone = { if (state.canSubmit) viewModel.pair() },
                    )
                    if (state.scannedBus.isNotBlank()) {
                        Text(
                            stringResource(R.string.scanned_bus, state.scannedBus),
                            style = BusType.small,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            state.error?.let { message ->
                ErrorSentence(message)
                OfficeHelp()
            }

            // Room under the last field so the bottom bar never covers it.
            Spacer(Modifier.height(24.dp))
        }
    }
}
