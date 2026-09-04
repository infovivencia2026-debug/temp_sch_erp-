package com.schoolerp.bustracker.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.ui.theme.BusType

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
    // Saveable, or a rotation mid-run reset DONE and re-asked the driver.
    var stage by rememberSaveable { mutableStateOf(Stage.EXPLAIN_FOREGROUND) }

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
            title = stringResource(R.string.perm_title),
            lines = listOf(
                stringResource(R.string.perm_where_h) to stringResource(R.string.perm_where_b),
                stringResource(R.string.perm_only_run_h) to stringResource(R.string.perm_only_run_b),
                stringResource(R.string.perm_precise_h) to stringResource(R.string.perm_precise_b),
            ),
            confirmLabel = stringResource(R.string.perm_continue),
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
            title = stringResource(R.string.perm_bg_title),
            lines = listOf(
                stringResource(R.string.perm_bg_why_h) to stringResource(R.string.perm_bg_why_b),
                stringResource(R.string.perm_bg_next_h) to stringResource(R.string.perm_bg_next_b),
            ),
            confirmLabel = stringResource(R.string.perm_open_settings),
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
        title = { Text(title, style = BusType.display) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                lines.forEach { (heading, detail) ->
                    Column {
                        Text(heading, style = BusType.bodyStrong)
                        Text(detail, style = BusType.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
        // The one the driver should press is a filled button, the other is a word.
        confirmButton = {
            Button(onClick = onConfirm, modifier = Modifier.heightIn(min = 56.dp)) {
                Text(confirmLabel, style = BusType.bodyStrong)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.perm_not_now), style = BusType.small)
            }
        },
    )
}

private enum class Stage { EXPLAIN_FOREGROUND, EXPLAIN_BACKGROUND, DONE }
