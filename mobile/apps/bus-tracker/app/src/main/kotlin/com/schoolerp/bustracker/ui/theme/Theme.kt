package com.schoolerp.bustracker.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightScheme = lightColorScheme(
    primary = Color(0xFF1B4332),
    secondary = Color(0xFF40916C),
    tertiary = Color(0xFF5A7D2A),
    error = Color(0xFFB3261E),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF95D5B2),
    secondary = Color(0xFFB7E4C7),
    tertiary = Color(0xFFB4D08A),
    error = Color(0xFFF2B8B5),
)

/* THE SCHOOL'S COLOURS, NOT THE DRIVER'S WALLPAPER.

   Dynamic colour was taken unconditionally on Android 12 and above, which is
   every phone this app is realistically installed on. So the two schemes above
   -- chosen greens, an amber for a run in progress, a red that has to read as
   a fault -- were dead code, and the app took its palette from whatever
   photograph the driver had set as a wallpaper.

   That is what made it look wrong rather than merely plain: it looked
   different on every handset in the yard, it matched nothing else the school
   uses, and on a pink or lilac wallpaper the "stop" red and the "running"
   green stopped being distinguishable at a glance -- on a screen that is
   glanced at from a driving seat, in daylight, and never studied.

   Material You is still honoured where it costs nothing: a school that wants
   it can pass dynamic = true. The default is the school's own colours, which
   is the only palette that means the same thing on two different phones. */
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
    MaterialTheme(colorScheme = scheme, content = content)
}
