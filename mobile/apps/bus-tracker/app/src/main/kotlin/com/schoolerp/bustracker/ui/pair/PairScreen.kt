package com.schoolerp.bustracker.ui.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.bustracker.core.PairCode
import androidx.compose.material3.TextButton
import androidx.compose.ui.text.input.PasswordVisualTransformation

@Composable
fun PairScreen(viewModel: PairViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Sign in", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Use the login the school office gave you. Your bus and your route are " +
                "already set — there is nothing to choose. This phone reports where " +
                "the bus is only while a run is open: nothing before you press Start " +
                "Run, nothing after you press End Run.",
            style = MaterialTheme.typography.bodyMedium,
        )

        /* NO ADDRESS FIELD.
         *
           A driver is handed a download link and a login, and that is all he
           should ever have to hold. He does not know a server address, cannot
           be told one over the phone reliably, and a typo produced a failure
           indistinguishable from a wrong password. The address is compiled in
           -- one deployment, one host, and the sign-in works out which school
           from the driver's own login. Only a debug build may edit it. */
        if (state.baseUrlEditable) {
            OutlinedTextField(
                value = state.baseUrl,
                onValueChange = viewModel::onBaseUrlChanged,
                label = { Text("Server address (debug)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        /* THE DRIVER'S OWN DETAILS, first.
         *
         * A pair code needs somebody in the office at the moment the driver is
         * beside the bus, and that is six in the morning. HR already records
         * who drives which bus, so this is enough on its own and the server
         * answers with the vehicle -- which is also narrower than a code was,
         * because a driver cannot attach this phone to a route that is not
         * theirs.
         */
        if (!state.usePairCode) {
            OutlinedTextField(
                value = state.phone,
                onValueChange = viewModel::onPhoneChanged,
                label = { Text("Your mobile number") },
                supportingText = { Text("The number the school office has for you.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.pin,
                onValueChange = viewModel::onPinChanged,
                label = { Text("Password") },
                supportingText = { Text("The same password you use to sign in to the school website.") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.pairCodeAvailable) {
                TextButton(onClick = { viewModel.usePairCode(true) }) {
                    Text("I was given a pairing code instead")
                }
            }
        } else {
        OutlinedTextField(
                value = state.pairCode,
                onValueChange = viewModel::onPairCodeChanged,
                label = { Text("Pairing code") },
                supportingText = {
                    Text(
                        "${state.pairCode.length} of ${PairCode.LENGTH} characters. " +
                            "Codes expire after ten minutes.",
                    )
                },
                singleLine = true,
                textStyle = MaterialTheme.typography.headlineSmall.copy(
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 4.sp,
                ),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    keyboardType = KeyboardType.Ascii,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            TextButton(onClick = { viewModel.usePairCode(false) }) {
                Text("Use my number and PIN instead")
            }
        }

        if (state.insecureToggleAvailable) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Allow plain http://", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Debug builds only, for a server on your own machine. The device " +
                            "token and the bus's position would travel unencrypted.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(
                    checked = state.allowInsecureHttp,
                    onCheckedChange = viewModel::onAllowInsecureChanged,
                )
            }
        }

        state.error?.let { message ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }

        // The registration is the point of this card. The office chose the bus
        // when it generated the code; the driver is the last person who can
        // catch it being the wrong one, and only if they are shown it before
        // the phone starts reporting.
        state.pairedVehicle?.let { registration ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("This phone is now", style = MaterialTheme.typography.titleMedium)
                    Text(registration, style = MaterialTheme.typography.headlineMedium)
                    state.pairedInstitution?.let {
                        Text(it, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        "Is that the bus you are driving today?",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(onClick = viewModel::rejectVehicle) {
                            Text("No — stop")
                        }
                        Text(
                            "Yes: close this and start your run.",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                }
            }
        }

        Button(
            onClick = viewModel::pair,
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.submitting) {
                CircularProgressIndicator(modifier = Modifier.height(20.dp))
            } else {
                Text("Pair")
            }
        }
    }
}
