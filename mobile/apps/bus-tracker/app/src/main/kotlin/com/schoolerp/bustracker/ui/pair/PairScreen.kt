package com.schoolerp.bustracker.ui.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/* THE DRIVER SIGNS IN. HE DOES NOT PAIR.
 *
 * The whole credential path was already here and had been for weeks: the view
 * model holds `phone` and `pin`, `canSubmit` validates them, `pair()` branches
 * to `repository.driverSignIn`, and the server grew a public
 * /bus-tracker/driver-signin endpoint to answer it. None of it could ever run,
 * because this screen rendered one field — the pairing code — and offered no
 * way to reach the other branch. `usePairCode` defaulted to true and nothing
 * on screen could set it to false.
 *
 * That is the same defect this codebase keeps producing: code that reads
 * correctly and can never take effect. A driver opening the app was asked for
 * a code that only somebody sitting in the office at six in the morning could
 * give him, when what he was actually handed was a login.
 *
 * So the screen is the login now: the number or email the school issued, the
 * password, sign in. The pairing code stays reachable behind one line of text
 * for a bus with no driver assigned to it yet, which is the case it was
 * genuinely for.
 */
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
        Text(
            if (state.usePairCode) "Pair this phone" else "Sign in to drive",
            style = MaterialTheme.typography.headlineSmall,
        )

        if (state.usePairCode) {
            OutlinedTextField(
                value = state.pairCode,
                onValueChange = viewModel::onPairCodeChanged,
                label = { Text("Pairing code") },
                singleLine = true,
                textStyle = MaterialTheme.typography.headlineSmall.copy(
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 4.sp,
                ),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                // fillMaxWidth, not a fixed width: the letter-spaced monospace
                // above is what pushed this off the side of a narrow handset.
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            OutlinedTextField(
                value = state.phone,
                onValueChange = viewModel::onPhoneChanged,
                label = { Text("Mobile number or email") },
                singleLine = true,
                /* Email, not Phone. The school issues drivers the same login
                   everybody else gets and it is as often an address as a
                   number; a numeric keypad on an email field is a dead end the
                   driver cannot get out of. */
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.pin,
                onValueChange = viewModel::onPinChanged,
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.scannedBus.isNotBlank()) {
                Text(
                    "Bus ${state.scannedBus}",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }

        state.error?.let { message ->
            Text(
                message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                // Wraps rather than running off the edge: a server sentence is
                // longer than a phone is wide.
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Button(
            onClick = viewModel::pair,
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.submitting) {
                // On the button's own colour, or it is invisible: the default
                // is `primary`, which is the filled button's background.
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.onPrimary,
                    strokeWidth = 2.dp,
                )
            } else {
                Text(if (state.usePairCode) "Pair this phone" else "Sign in")
            }
        }

        /* One line, at the bottom, in the quietest thing on the screen. The
           driver with a login never has to read it; the one standing beside a
           bus nobody has assigned him to can still get moving. */
        if (state.pairCodeAvailable) {
            TextButton(
                onClick = { viewModel.usePairCode(!state.usePairCode) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (state.usePairCode) "Sign in with your school login instead"
                    else "I was given a pairing code instead",
                )
            }
        }
    }
}
