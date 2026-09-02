package com.schoolerp.smsgateway.ui.status

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.smsgateway.core.GwLog
import com.schoolerp.smsgateway.data.local.FailureRow
import com.schoolerp.smsgateway.engine.Blocker
import com.schoolerp.smsgateway.engine.ConnectionState
import com.schoolerp.smsgateway.engine.GatewayStatus
import com.schoolerp.smsgateway.sms.SmsFailure
import java.text.DateFormat
import java.util.Date

@Composable
fun StatusScreen(
    onUnpaired: () -> Unit,
    viewModel: StatusViewModel = hiltViewModel(),
) {
    val status by viewModel.status.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }

    // Some ROMs ship without the battery or notification settings screens
    // these intents name, and an unhandled ActivityNotFoundException took the
    // only screen the clerk has down with it.
    fun open(intent: android.content.Intent) {
        runCatching { context.startActivity(intent) }
            .onFailure { GwLog.w("ui", "no activity for ${intent.action}", it) }
    }

    // Permissions can be revoked from Settings while this app is in the
    // background, so the snapshot is re-read on every resume.
    LifecycleResumeEffect(Unit) {
        viewModel.refresh()
        onPauseOrDispose { }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Headline(status) }

        // The blockers come first and stay first. Someone opening this screen
        // has almost always opened it because something is wrong.
        items(status.blockers, key = { it.name }) { blocker ->
            BlockerCard(
                blocker = blocker,
                onOpenAppSettings = { open(viewModel.openAppSettings()) },
                onOpenNotificationSettings = { open(viewModel.openNotificationSettings()) },
                onRequestBatteryExemption = { open(viewModel.requestBatteryExemption()) },
                onStartService = viewModel::startService,
            )
        }

        item { CountsCard(status) }

        if (status.recentFailures.isNotEmpty()) {
            item {
                Text(
                    "Recent failures",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            items(status.recentFailures, key = { it.id }) { FailureItem(it) }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                // Only the one that would do something is live, which is also
                // the only feedback a tap on either gets.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = viewModel::startService,
                        enabled = !status.serviceRunning,
                    ) { Text("Start") }
                    OutlinedButton(
                        onClick = viewModel::stopService,
                        enabled = status.serviceRunning,
                    ) { Text("Stop") }
                }
                // One tap wiped the credential and every pairing setting, with
                // nothing on screen but the status screen vanishing.
                TextButton(onClick = { confirmUnpair = true }) { Text("Unpair this phone") }
                Text(
                    "Polling every ${status.pollSeconds}s, at most ${status.maxPerMinute} " +
                        "messages a minute. Both are set by the school's server.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = {
                Text(
                    "This phone stops sending the school's messages and forgets its pairing. " +
                        "Pairing again needs a new code from the office.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    viewModel.unpair()
                    onUnpaired()
                }) { Text("Unpair") }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) { Text("Keep it paired") }
            },
        )
    }
}

@Composable
private fun Headline(status: GatewayStatus) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                status.institutionName ?: "Not paired",
                style = MaterialTheme.typography.titleLarge,
            )
            Text(status.summary, style = MaterialTheme.typography.bodyLarge)
            Text(
                connectionLine(status),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

private fun connectionLine(status: GatewayStatus): String {
    val last = if (status.lastPollAt > 0) {
        "last contact ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(status.lastPollAt))}"
    } else {
        "no contact yet"
    }
    return when (status.connection) {
        ConnectionState.CONNECTED -> "Connected — $last"
        ConnectionState.RETRYING -> "Retrying (${status.lastServerError ?: "no reason given"}) — $last"
        ConnectionState.UNAUTHORISED -> "The server rejected this phone's token. Pair again."
        ConnectionState.NEVER_CONNECTED -> "Not connected — $last"
    }
}

@Composable
private fun CountsCard(status: GatewayStatus) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            CountRow("Sent today", status.sentToday.toString())
            CountRow("Failed today", status.failedToday.toString())
            CountRow("Waiting to send", status.queueDepth.toString())
            CountRow("Not yet reported to the server", status.pendingReceipts.toString())
            if (status.pendingReceipts > 0) {
                Text(
                    "Until a receipt reaches the server, the server assumes those messages " +
                        "were never sent and will hand them out again.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun CountRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The label yields, the number never does: on a narrow handset at a
        // large font the two used to collide.
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

@Composable
private fun BlockerCard(
    blocker: Blocker,
    onOpenAppSettings: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onStartService: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = if (blocker.stopsSending) {
            CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
            )
        } else {
            CardDefaults.cardColors()
        },
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(blocker.headline, style = MaterialTheme.typography.titleMedium)
            Text(blocker.detail, style = MaterialTheme.typography.bodyMedium)
            when (blocker) {
                Blocker.SMS_PERMISSION_DENIED, Blocker.PHONE_STATE_DENIED ->
                    OutlinedButton(onClick = onOpenAppSettings) { Text("Open app settings") }
                Blocker.NOTIFICATIONS_BLOCKED ->
                    OutlinedButton(onClick = onOpenNotificationSettings) { Text("Turn notifications on") }
                Blocker.BATTERY_OPTIMISED ->
                    OutlinedButton(onClick = onRequestBatteryExemption) {
                        Text("Let this app run in the background")
                    }
                Blocker.SERVICE_NOT_RUNNING ->
                    OutlinedButton(onClick = onStartService) { Text("Start the gateway") }
                else -> Unit
            }
        }
    }
}

@Composable
private fun FailureItem(row: FailureRow) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // The id, not the recipient and not the text. A failure list that
            // named parents would be a leak sitting on the office desk.
            Text("Message ${row.id}", style = MaterialTheme.typography.labelMedium)
            Text(SmsFailure.explain(row.error), style = MaterialTheme.typography.bodyMedium)
            row.sentAt?.let {
                Text(
                    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}
