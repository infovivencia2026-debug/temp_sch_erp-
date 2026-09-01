package com.schoolerp.smsgateway.ui.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.smsgateway.core.PairCode

@Composable
fun PairScreen(
    onPaired: () -> Unit,
    viewModel: PairViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            if (state.usePairCode) "Pair this phone" else "Sign in",
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            if (state.usePairCode) {
                "This handset becomes the school's SMS sender. Type the nine-digit " +
                    "code shown on the school's Message Channels screen. Somebody at " +
                    "the school then approves this phone before it sends anything. It " +
                    "only ever sends messages the server gives it: it cannot compose " +
                    "anything, and it never reads your inbox or contacts."
            } else {
                "This handset becomes the school's SMS sender. Sign in with the login " +
                    "the office already uses. It will only ever send messages the school's " +
                    "server gives it: it cannot compose anything, and it never reads your " +
                    "inbox or contacts."
            },
            style = MaterialTheme.typography.bodyMedium,
        )

        /* No address field off a debug build. The office types a login, not a
           URL, and a typo in a hostname fails exactly like a wrong password. */
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

        if (!state.usePairCode) {
            OutlinedTextField(
                value = state.phone,
                onValueChange = viewModel::onPhoneChanged,
                label = { Text("Mobile number or email") },
                supportingText = { Text("Whoever in the office this phone belongs to.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.password,
                onValueChange = viewModel::onPasswordChanged,
                label = { Text("Password") },
                supportingText = { Text("The same password used on the school website.") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.pairCodeAvailable) {
                TextButton(onClick = { viewModel.usePairCode(true) }) {
                    Text("I was given a pair code instead")
                }
            }
        } else {
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = viewModel::onPairCodeChanged,
            label = { Text("Pair code") },
            supportingText = {
                Text("${state.pairCode.length} of ${PairCode.LENGTH} digits. Codes expire after ten minutes.")
            },
            singleLine = true,
            textStyle = MaterialTheme.typography.headlineSmall.copy(
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp,
            ),
            /* The numeric pad, because the code is digits now. An Ascii
               keyboard on a nine-digit field makes a clerk switch layouts and
               hunt for the number row on a phone they may not own. */
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )
            TextButton(onClick = { viewModel.usePairCode(false) }) {
                Text("Use the office login instead")
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
                        "Debug builds only, for a server on your own machine. " +
                            "The device token would travel unencrypted.",
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

        state.pairedTo?.let { school ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Paired", style = MaterialTheme.typography.titleMedium)
                    // Showing the name back is the only way the operator can tell
                    // they typed the code for the right school.
                    Text(school, style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "If that is not your school, unpair from the status screen and " +
                            "ask for a new code.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(onClick = {
                        viewModel.dismissConfirmation()
                        onPaired()
                    }) { Text("Continue") }
                }
            }
        }

        Spacer(Modifier.height(8.dp))

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
