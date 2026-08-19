package com.schoolerp.smsgateway.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

/** The three permissions this app asks for, and no others. */
val gatewayPermissions: List<String>
    get() = buildList {
        add(Manifest.permission.SEND_SMS)
        add(Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

/**
 * Asks once, with the reason first.
 *
 * A school clerk handed a bare "Allow this app to send SMS?" dialog will refuse
 * it, and then the gateway silently does nothing for a week. So the rationale
 * comes first, in the same words the status screen uses, and a refusal is not
 * hidden — it becomes a blocker on the status screen rather than a queue that
 * grows for ever.
 */
@Composable
fun PermissionPrompt(onFinished: () -> Unit = {}) {
    val context = LocalContext.current
    var explained by remember { mutableStateOf(false) }

    val missing = remember {
        gatewayPermissions.filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }
    }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onFinished() }

    if (missing.isEmpty() || explained) return

    AlertDialog(
        onDismissRequest = {
            explained = true
            onFinished()
        },
        title = { Text("What this phone needs") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Reason(
                    "Send SMS",
                    "The school's messages are sent from this SIM. Without it nothing goes out.",
                )
                Reason(
                    "Notifications",
                    "A permanent notice keeps the gateway running in the background. " +
                        "Android stops the app without it.",
                )
                Reason(
                    "Phone state",
                    "Reports signal strength and whether the SIM is ready, so the office can " +
                        "see why a message failed. Refusing it only costs that reporting.",
                )
                Text(
                    "This app does not read your messages and does not read your contacts. " +
                        "It can only send what the school's server hands it.",
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                explained = true
                launcher.launch(missing.toTypedArray())
            }) { Text("Continue") }
        },
        dismissButton = {
            TextButton(onClick = {
                explained = true
                onFinished()
            }) { Text("Not now") }
        },
    )
}

@Composable
private fun Reason(title: String, detail: String) {
    Column {
        Text(title, style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
        Text(detail, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
    }
}
