package com.schoolerp.bustracker.ui.run

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.schoolerp.bustracker.data.local.StopEntity
import com.schoolerp.bustracker.data.local.StudentEntity
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP
import com.schoolerp.bustracker.data.remote.Notice
import com.schoolerp.bustracker.engine.Headcount

/**
 * The office's message, above everything else, with one button.
 *
 * Not a dialog: a dialog over a moving bus is dismissed by the thumb that
 * steadies the phone, and then it is gone and the office thinks it was read.
 * A banner stays until OK is tapped on purpose, and OK is what the office
 * sees.
 */
@Composable
fun NoticeBanner(notices: List<Notice>, onAcknowledge: (String) -> Unit) {
    val notice = notices.firstOrNull() ?: return
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (notices.size > 1) "Message from the school (${notices.size})" else "Message from the school",
                style = MaterialTheme.typography.labelLarge,
            )
            Text(notice.body, style = MaterialTheme.typography.titleMedium)
            Button(
                onClick = { onAcknowledge(notice.id) },
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) { Text("OK, seen it") }
        }
    }
}

/**
 * The children, stop by stop.
 *
 * Grouped under the stops rather than listed flat, because the question at a
 * stop is "who gets on here", and a flat list of forty names answers it
 * slowly. The next stop is open by default and every other stop is a line
 * with its count; a tap opens it.
 */
@Composable
fun ChildrenByStop(
    stops: List<StopEntity>,
    students: List<StudentEntity>,
    direction: String,
    pendingMarks: Int,
    onMark: (String, String) -> Unit,
    photo: suspend (String) -> Bitmap?,
) {
    if (students.isEmpty()) {
        Text(
            "Nobody is allocated to this route yet, or the school has not answered. " +
                "The run still tracks either way.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    val byStop = students.groupBy { it.stopId }
    val nextStopId = stops.firstOrNull { it.arrivedAtMillis == null }?.stopId
    var opened by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val total = Headcount.of(students, direction)
        Text("Children on this run", style = MaterialTheme.typography.titleLarge)
        Text(total.summary(direction), style = MaterialTheme.typography.bodyMedium)
        if (pendingMarks > 0) {
            Text(
                "$pendingMarks marks waiting for signal. Nothing is lost.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        val groups = stops.map { it.stopId to it.name } +
            listOfNotNull(if (byStop.containsKey("")) "" to "No stop set" else null)
        groups.forEach { (stopId, stopName) ->
            val here = byStop[stopId] ?: return@forEach
            val count = Headcount.of(here, direction)
            val isOpen = (opened ?: nextStopId) == stopId
            StopGroup(
                name = stopName,
                count = count,
                direction = direction,
                open = isOpen,
                onToggle = { opened = if (isOpen) "-" else stopId },
            ) {
                here.forEach { child ->
                    StudentRow(child, direction, onMark, photo)
                }
            }
        }
    }
}

@Composable
private fun StopGroup(
    name: String,
    count: Headcount,
    direction: String,
    open: Boolean,
    onToggle: () -> Unit,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedButton(onClick = onToggle, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth()) {
                Text(name, style = MaterialTheme.typography.titleMedium)
                Text(
                    count.summary(direction),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (count.complete) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                )
            }
        }
        if (open) content()
    }
}

@Composable
private fun StudentRow(
    child: StudentEntity,
    direction: String,
    onMark: (String, String) -> Unit,
    photo: suspend (String) -> Bitmap?,
) {
    val muted = child.absent
    val textColor = if (muted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StudentPhoto(child, photo)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(child.name, style = MaterialTheme.typography.titleMedium, color = textColor)
            val detail = listOf(child.className, child.admissionNo).filter { it.isNotBlank() }.joinToString(" · ")
            if (detail.isNotBlank()) {
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (muted) {
                /* Somebody else's word, greyed rather than hidden: the driver
                   still needs to know not to wait, and to see the name if the
                   child turns up at the stop anyway. */
                Text(
                    "${child.absentReason.ifBlank { "Reported absent" }}. Do not wait.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            } else {
                MarkButtons(child, direction, onMark)
            }
        }
    }
}

@Composable
private fun MarkButtons(child: StudentEntity, direction: String, onMark: (String, String) -> Unit) {
    // Pickup asks "on or absent"; drop asks "off or absent". Three buttons
    // for two answers is one more thing to get wrong at a kerb.
    val done = if (direction == DIRECTION_DROP) "alighted" to "Off" else "boarded" to "On"
    val choices = listOf(done, "absent" to "Absent")
    val current = child.effectiveStatus
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        choices.forEach { (value, label) ->
            if (current == value) {
                Button(onClick = {}, enabled = false, modifier = Modifier.weight(1f)) {
                    Text(if (child.pendingStatus != null) "$label ·" else label)
                }
            } else {
                OutlinedButton(onClick = { onMark(child.studentId, value) }, modifier = Modifier.weight(1f)) {
                    Text(label)
                }
            }
        }
    }
}

/**
 * The face, or the initials until it arrives. Fetched once per child and
 * kept on the phone, so a relief driver on an unfamiliar route has it in the
 * dead zone too.
 */
@Composable
private fun StudentPhoto(child: StudentEntity, photo: suspend (String) -> Bitmap?) {
    val bitmap by produceState<Bitmap?>(initialValue = null, key1 = child.studentId, key2 = child.hasPhoto) {
        value = if (child.hasPhoto) photo(child.studentId) else null
    }
    Box(
        modifier = Modifier
            .size(56.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        val image = bitmap
        if (image != null) {
            Image(
                bitmap = image.asImageBitmap(),
                contentDescription = child.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(56.dp),
            )
        } else {
            Text(
                child.name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() },
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}
