package com.schoolerp.bustracker.ui.theme

import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* ONE ACCENT, ONE WARNING, AND EVERYTHING ELSE IS INK ON PAPER.

   The palette is chosen for a phone in a cradle in daylight. Every text and
   background pair below was measured at 4.5:1 or better (most are far
   above); the numbers are in the commit message so a later change can be
   checked against them rather than eyeballed.

   - primary is the school's green: buttons, the one tracking-on tint, the
     selected route. Nothing else is coloured for decoration.
   - error is the warning: the phone cannot report, End run, absent.
   - surfaceVariant is the only grey: rows, cards, the code boxes.
   Dynamic colour is still offered for a school that wants it, but is off by
   default because a driver's wallpaper must not decide what "tracking"
   looks like. */
private val LightScheme = lightColorScheme(
    primary = Color(0xFF0F6B3F),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD7F0E1),
    onPrimaryContainer = Color(0xFF0A3B23),
    secondary = Color(0xFF0F6B3F),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD7F0E1),
    onSecondaryContainer = Color(0xFF0A3B23),
    tertiary = Color(0xFF0F6B3F),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD7F0E1),
    onTertiaryContainer = Color(0xFF0A3B23),
    error = Color(0xFFB3261E),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFBE1DE),
    onErrorContainer = Color(0xFF7A1410),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF14171A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14171A),
    surfaceVariant = Color(0xFFEEF1EF),
    onSurfaceVariant = Color(0xFF3A4340),
    surfaceContainer = Color(0xFFEEF1EF),
    surfaceContainerLow = Color(0xFFF6F8F7),
    surfaceContainerHigh = Color(0xFFE4E8E6),
    surfaceContainerHighest = Color(0xFFE4E8E6),
    outline = Color(0xFF5C6662),
    outlineVariant = Color(0xFFC5CCC8),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF86D9AC),
    onPrimary = Color(0xFF06301B),
    primaryContainer = Color(0xFF1B4A32),
    onPrimaryContainer = Color(0xFFD7F0E1),
    secondary = Color(0xFF86D9AC),
    onSecondary = Color(0xFF06301B),
    secondaryContainer = Color(0xFF1B4A32),
    onSecondaryContainer = Color(0xFFD7F0E1),
    tertiary = Color(0xFF86D9AC),
    onTertiary = Color(0xFF06301B),
    tertiaryContainer = Color(0xFF1B4A32),
    onTertiaryContainer = Color(0xFFD7F0E1),
    error = Color(0xFFFF9C93),
    onError = Color(0xFF3B0906),
    errorContainer = Color(0xFF5C1A14),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF0F1311),
    onBackground = Color(0xFFF3F5F4),
    surface = Color(0xFF0F1311),
    onSurface = Color(0xFFF3F5F4),
    surfaceVariant = Color(0xFF1C2320),
    onSurfaceVariant = Color(0xFFC3CCC7),
    surfaceContainer = Color(0xFF1C2320),
    surfaceContainerLow = Color(0xFF161B18),
    surfaceContainerHigh = Color(0xFF262E2A),
    surfaceContainerHighest = Color(0xFF262E2A),
    outline = Color(0xFF7E8A85),
    outlineVariant = Color(0xFF3A4440),
)

/* THREE SIZES.

   A driver reads this screen at arm's length through glare, so there is one
   size for the thing he is looking for, one for everything he reads, and one
   for the small print. Every Material slot maps to one of the three so that
   a dialog title, a button label and a list row cannot drift into a fourth. */
object BusType {
    val display = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold)
    val body = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Normal)
    val bodyStrong = body.copy(fontWeight = FontWeight.SemiBold)
    val small = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal)
}

private val BusTypography = Typography(
    displayLarge = BusType.display,
    displayMedium = BusType.display,
    displaySmall = BusType.display,
    headlineLarge = BusType.display,
    headlineMedium = BusType.display,
    headlineSmall = BusType.display,
    titleLarge = BusType.display,
    titleMedium = BusType.bodyStrong,
    titleSmall = BusType.bodyStrong,
    bodyLarge = BusType.body,
    bodyMedium = BusType.body,
    bodySmall = BusType.small,
    labelLarge = BusType.bodyStrong,
    labelMedium = BusType.small,
    labelSmall = BusType.small,
)

private val BusShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun BusTrackerTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamic: Boolean = false,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val scheme = when {
        dynamic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> DarkScheme
        else -> LightScheme
    }
    MaterialTheme(colorScheme = scheme, typography = BusTypography, shapes = BusShapes, content = content)
}

/**
 * True when the phone's "remove animations" accessibility setting is on. The
 * few animations this app has are skipped rather than shortened, because a
 * driver who turned motion off did not want a faster version of it.
 */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
}
