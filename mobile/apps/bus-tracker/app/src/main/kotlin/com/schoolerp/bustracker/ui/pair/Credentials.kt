package com.schoolerp.bustracker.ui.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.ui.theme.BusType
import com.schoolerp.bustracker.ui.theme.CodeBoxes
import com.schoolerp.bustracker.ui.theme.QuietLink
import com.schoolerp.bustracker.ui.theme.SectionLabel

/**
 * The number and the PIN, the same on the pairing screen and on the run
 * screen's shift sign-in, so a driver learns one form.
 *
 * Phone keypad for the number, six boxes on the same keypad for the PIN. The
 * email-and-password shape the office sometimes issues is one quiet line
 * away and swaps both keyboards; it is never shown alongside.
 */
@Composable
fun DriverCredentials(
    phone: String,
    onPhoneChanged: (String) -> Unit,
    pin: String,
    onPinChanged: (String) -> Unit,
    emailLogin: Boolean,
    onEmailLoginChanged: (Boolean) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val loginLabel = stringResource(if (emailLogin) R.string.signin_login else R.string.signin_phone)
        SectionLabel(loginLabel)
        OutlinedTextField(
            value = phone,
            onValueChange = onPhoneChanged,
            placeholder = {
                Text(loginLabel, style = BusType.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
            },
            singleLine = true,
            textStyle = BusType.display,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (emailLogin) KeyboardType.Email else KeyboardType.Phone,
                imeAction = ImeAction.Next,
            ),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(stringResource(R.string.signin_phone)),
        )

        if (emailLogin) {
            val passwordLabel = stringResource(R.string.signin_password)
            SectionLabel(passwordLabel)
            OutlinedTextField(
                value = pin,
                onValueChange = onPinChanged,
                placeholder = {
                    Text(passwordLabel, style = BusType.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
                },
                singleLine = true,
                textStyle = BusType.display,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(passwordLabel),
            )
        } else {
            SectionLabel(stringResource(R.string.signin_pin_hint))
            CodeBoxes(
                value = pin,
                onValueChange = { onPinChanged(it.filter(Char::isDigit)) },
                label = stringResource(R.string.signin_pin),
                masked = true,
                onDone = onDone,
            )
        }

        QuietLink(
            text = stringResource(if (emailLogin) R.string.signin_use_phone else R.string.signin_use_email),
            onClick = {
                // A PIN typed into boxes is not a password and the other way
                // round; the secret starts again with the keyboard.
                onPinChanged("")
                onEmailLoginChanged(!emailLogin)
            },
        )
    }
}
