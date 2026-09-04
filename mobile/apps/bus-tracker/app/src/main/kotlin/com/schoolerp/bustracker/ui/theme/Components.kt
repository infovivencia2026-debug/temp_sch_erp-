package com.schoolerp.bustracker.ui.theme

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.schoolerp.bustracker.BuildConfig
import com.schoolerp.bustracker.R
import com.schoolerp.bustracker.core.BtLog

/** The one action on the screen: full width, 64dp, at the bottom. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    warning: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = MaterialTheme.shapes.medium,
        colors = if (warning) {
            ButtonDefaults.buttonColors(containerColor = scheme.error, contentColor = scheme.onError)
        } else {
            ButtonDefaults.buttonColors()
        },
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                color = if (warning) scheme.onError else scheme.onPrimary,
                strokeWidth = 3.dp,
            )
        } else {
            Text(text, style = BusType.display, textAlign = TextAlign.Center)
        }
    }
}

/** A second, rarer action: outlined, still a thumb-sized target, never the biggest thing. */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.heightIn(min = 56.dp),
    ) { Text(text, style = BusType.bodyStrong) }
}

/** One quiet line of text that does something. Small on purpose and away from the primary action. */
@Composable
fun QuietLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    TextButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp)) {
        Text(text, style = BusType.small, color = MaterialTheme.colorScheme.primary)
    }
}

/** Small print above a group. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = BusType.small,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(top = 4.dp),
    )
}

/** The mistake, in one sentence, in the warning colour. */
@Composable
fun ErrorSentence(message: String, modifier: Modifier = Modifier) {
    Text(
        message,
        style = BusType.body,
        color = MaterialTheme.colorScheme.error,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = message },
    )
}

/**
 * Who to ring when the sentence above is not enough. The number is compiled
 * in per deployment (-PofficePhone=...); without one the line still says
 * where help is.
 */
@Composable
fun OfficeHelp(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val phone = BuildConfig.OFFICE_PHONE
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            stringResource(R.string.office_help),
            style = BusType.small,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (phone.isNotBlank()) {
            QuietLink(
                text = stringResource(R.string.office_call) + "  " + phone,
                onClick = {
                    runCatching {
                        context.startActivity(
                            Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }.onFailure { BtLog.w("ui", "no dialler", it) }
                },
            )
        }
    }
}

const val CODE_LENGTH = 6

/**
 * Six boxes, one digit each, on a numeric keypad. One invisible text field
 * sits over the boxes so the keyboard, paste and TalkBack all work as they
 * do for any field; the boxes only draw what it holds.
 */
@Composable
fun CodeBoxes(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    masked: Boolean = false,
    enabled: Boolean = true,
    imeAction: ImeAction = ImeAction.Done,
    onDone: () -> Unit = {},
) {
    val scheme = MaterialTheme.colorScheme
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = value,
        onValueChange = { onValueChange(it.filter(Char::isLetterOrDigit).take(CODE_LENGTH)) },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { onDone() }, onNext = { onDone() }),
        textStyle = TextStyle(color = Color.Transparent, fontSize = 1.sp),
        cursorBrush = SolidColor(Color.Transparent),
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { focused = it.isFocused }
            .testTag(label)
            .semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    repeat(CODE_LENGTH) { index ->
                        val filled = index < value.length
                        val active = focused && index == value.length.coerceAtMost(CODE_LENGTH - 1)
                        val border = when {
                            active -> scheme.primary
                            filled -> scheme.onSurface
                            else -> scheme.outlineVariant
                        }
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .height(64.dp)
                                .clip(MaterialTheme.shapes.small)
                                .background(scheme.surfaceVariant)
                                .border(if (active) 3.dp else 2.dp, border, MaterialTheme.shapes.small),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (filled) {
                                Text(
                                    if (masked) "●" else value[index].toString(),
                                    style = BusType.display,
                                    color = scheme.onSurface,
                                )
                            }
                        }
                    }
                }
                // The real field, over the boxes and invisible: a tap anywhere
                // on the row focuses it and raises the keypad.
                Box(Modifier.matchParentSize().alpha(0f)) { inner() }
            }
        },
    )
}

/** What a tinted surface is allowed to mean. */
enum class Tone { CALM, PROBLEM, PLAIN }

/**
 * The status, in words, at the top of the screen. One calm colour for
 * "tracking", one warning colour for "the school cannot see you", plain grey
 * for everything that needs nobody to do anything.
 */
@Composable
fun StatusStrip(
    headline: String,
    tone: Tone,
    modifier: Modifier = Modifier,
    detail: String? = null,
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val reduced = rememberReducedMotion()
    val target = when (tone) {
        Tone.CALM -> scheme.primaryContainer
        Tone.PROBLEM -> scheme.errorContainer
        Tone.PLAIN -> scheme.surfaceVariant
    }
    val onTarget = when (tone) {
        Tone.CALM -> scheme.onPrimaryContainer
        Tone.PROBLEM -> scheme.onErrorContainer
        Tone.PLAIN -> scheme.onSurfaceVariant
    }
    val background by animateColorAsState(
        targetValue = target,
        animationSpec = if (reduced) snap() else tween(200),
        label = "status",
    )
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(background)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(headline, style = BusType.display, color = onTarget)
        detail?.let { Text(it, style = BusType.small, color = onTarget) }
        content?.invoke(this)
    }
}

/**
 * A row in a list: one thing per row, at least 64dp, the name first. Used
 * for buses, routes and stops so they all feel like the same list.
 */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.medium
    val base = modifier
        .fillMaxWidth()
        .heightIn(min = 64.dp)
        .clip(shape)
        .background(if (selected) scheme.primaryContainer else scheme.surfaceVariant)
        .then(if (selected) Modifier.border(2.dp, scheme.primary, shape) else Modifier)
    Row(
        modifier = (if (onClick != null) base.clickable(enabled = enabled, onClick = onClick) else base)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                style = BusType.bodyStrong,
                color = if (selected) scheme.onPrimaryContainer else scheme.onSurface,
            )
            subtitle?.let {
                Text(
                    it,
                    style = BusType.small,
                    color = if (selected) scheme.onPrimaryContainer else scheme.onSurfaceVariant,
                )
            }
        }
        trailing?.invoke(this)
    }
}
