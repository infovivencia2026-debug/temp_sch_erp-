package com.schoolerp.bustracker.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

/**
 * Location has to be asked for in two steps, and the order is not a style
 * choice — it is what the platform enforces.
 *
 * From Android 11 a request that includes ACCESS_BACKGROUND_LOCATION alongside
 * the foreground ones is denied outright, without showing the driver anything.
 * The foreground grant must land first; only then does the background request
 * do anything, and from Android 11 it does not show a dialog at all — it opens
 * the app's location settings page, where the driver has to pick "Allow all the
 * time" themselves. An app that fires both at once looks like it asked and
 * silently has neither, which is the exact invisible failure this app is
 * supposed to surface.
 */
@Composable
fun LocationPermissionPrompt(onFinished: () -> Unit = {}) {
    val context = LocalContext.current
    var stage by remember { mutableStateOf(Stage.EXPLAIN_FOREGROUND) }

    val hasForeground = remember(stage) {
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    }
    val hasBackground = remember(stage) {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
    }

    val foregroundLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        stage = if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            Stage.EXPLAIN_BACKGROUND
        } else {
            Stage.DONE
        }
        onFinished()
    }

    val backgroundLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        stage = Stage.DONE
        onFinished()
    }

    if (stage == Stage.DONE) return
    if (hasForeground && hasBackground) return

    when {
        !hasForeground && stage == Stage.EXPLAIN_FOREGROUND -> Explain(
            title = "This app needs your location",
            lines = listOf(
                "Where the bus is" to
                    "The school's map, and the message a parent gets when the bus is near " +
                    "their stop, are this phone's position and nothing else.",
                "Only during a run" to
                    "Nothing is recorded before you press Start Run or after you press End " +
                    "Run. Where you go in the evening is not collected and cannot be seen.",
                "Precise, not approximate" to
                    "An approximate position cannot tell a parent the bus has reached their " +
                    "stop. Please allow precise location.",
            ),
            confirmLabel = "Continue",
            onConfirm = {
                foregroundLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                    ) + notificationPermission(),
                )
            },
            onDismiss = {
                stage = Stage.DONE
                onFinished()
            },
        )

        hasForeground && !hasBackground -> Explain(
            title = "One more setting: \"Allow all the time\"",
            lines = listOf(
                "Why" to
                    "Android stops giving this app your position when the screen goes off, " +
                    "unless you choose \"Allow all the time\". That is most of a run, the " +
                    "bus would vanish from the school's map every time you put the phone down.",
                "What happens next" to
                    "Android will open its own settings page for this app. Choose Location, " +
                    "then \"Allow all the time\".",
            ),
            confirmLabel = "Open settings",
            onConfirm = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                } else {
                    stage = Stage.DONE
                    onFinished()
                }
            },
            onDismiss = {
                stage = Stage.DONE
                onFinished()
            },
        )
    }
}

private fun notificationPermission(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(Manifest.permission.POST_NOTIFICATIONS)
    } else {
        emptyArray()
    }

@Composable
private fun Explain(
    title: String,
    lines: List<Pair<String, String>>,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                lines.forEach { (heading, detail) ->
                    Column {
                        Text(heading, style = MaterialTheme.typography.titleSmall)
                        Text(detail, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Not now") } },
    )
}

private enum class Stage { EXPLAIN_FOREGROUND, EXPLAIN_BACKGROUND, DONE }
