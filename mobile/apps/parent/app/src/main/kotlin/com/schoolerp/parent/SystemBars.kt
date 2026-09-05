package com.schoolerp.parent

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.View
import android.view.WindowInsetsController
import android.webkit.WebView

/* THE BARS FOLLOW THE PAGE, NOT THE PHONE.

   The status bar and the gesture bar used to take their colour from the
   theme, and the theme takes its colour from the phone's night setting. That
   is right exactly as often as the page agrees with the phone, and the page
   does not have to: the portal has its own Appearance setting (web/src/lib/
   theme.ts) with light, dark and system, and a personality can recolour the
   ground on top of that. A parent who chose dark on a light phone got a
   white strip behind the clock over a black page, and dark icons on it, and
   the same at the bottom. Nothing says "web page inside an app" more
   plainly than a frame that is the wrong colour for its content.

   So the page says what colour its ground is, and the frame is repainted to
   match. The page does not have to know how to say it: the shell injects a
   few lines of script after every load (WATCH below) that read the body's
   computed background, report it through the bridge, and keep reporting it
   whenever the document root changes class or attribute, which is how the
   theme, the personality and the text size are all applied. One report per
   change, nothing per scroll frame.

   The colour is also remembered, per phone mode, for the next cold start.
   The in-app loading screen and the root behind the system bars are painted
   with it before the page has said anything, so a parent who chose dark does
   not get a light loading screen that cuts to a dark page. Per phone mode
   because a parent on "system" is dark at night and light in the morning,
   and the wrong remembered colour would put back the very flash this
   removes. The system splash on Android 12 and up is the one thing this
   cannot reach: it is drawn from the manifest theme before any of this code
   runs. It shows the phone's colour, which is the page's colour for every
   parent who has not chosen otherwise.

   WHY ROOT AND WEBVIEW ARE PAINTED HERE TOO. From targetSdk 35 the window is
   edge to edge and statusBarColor is ignored: the bars are transparent and
   what shows behind them is whatever view sits there, which in this app is
   the root's padding. Painting the root is painting the bars. On older
   versions the window still owns the bars, and the colour is set on it
   directly. Both are done, so a phone on either side of the line matches. */
internal object SystemBars {

    private const val PREFS = "shell"
    private const val KEY_LIGHT = "page_bg_light"
    private const val KEY_DARK = "page_bg_dark"

    /* Read once by the page after it paints. Idempotent per document, so
       calling it from both onPageCommitVisible and onPageFinished is safe:
       whichever runs first installs the watcher and the other is a no-op.
       The observer is on the document root's attributes, which is where the
       theme class and the personality and text attributes live; a route
       change never replaces the root, so one observer serves the session. */
    const val WATCH = """
(function () {
  var s = window.ErpShell;
  if (!s || typeof s.setPageColor !== 'function') return;
  if (window.__erpBars) return;
  window.__erpBars = true;
  var last = null;
  function ground() {
    var c = getComputedStyle(document.body).backgroundColor;
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') {
      c = getComputedStyle(document.documentElement).backgroundColor;
    }
    return c || '';
  }
  function report() {
    var c = ground();
    if (c === last) return;
    last = c;
    try { s.setPageColor(c); } catch (e) {}
  }
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-personality', 'data-text', 'data-corners']
  });
  report();
})();
"""

    fun watch(web: WebView) {
        web.evaluateJavascript(WATCH, null)
    }

    /* Paints everything that frames the page: the window, the root (which is
       the bars on 35+), the WebView's own ground (what shows before the page
       paints and during a reload), and the icon colour of both bars. */
    fun apply(activity: Activity, root: View, web: WebView?, colour: Int) {
        val window = activity.window
        val light = isLight(colour)

        window.setBackgroundDrawable(ColorDrawable(colour))
        root.setBackgroundColor(colour)
        web?.setBackgroundColor(colour)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            @Suppress("DEPRECATION")
            window.statusBarColor = colour
            @Suppress("DEPRECATION")
            window.navigationBarColor = colour
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            /* Without these Android draws its own translucent scrim over the
               three-button bar whenever it decides the colour behind it is
               not contrasty enough, which on a light page is a grey band at
               the bottom that belongs to nothing on screen. The bar's icons
               are set to the right brightness below; the scrim has nothing
               to add. */
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
        } else {
            @Suppress("DEPRECATION")
            val decor = window.decorView
            @Suppress("DEPRECATION")
            var flags = decor.systemUiVisibility
            @Suppress("DEPRECATION")
            flags = if (light) {
                flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            } else {
                flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                flags = if (light) {
                    flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                } else {
                    flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                }
            }
            @Suppress("DEPRECATION")
            decor.systemUiVisibility = flags
        }
    }

    /* The colour the page last reported while the phone was in the mode it
       is in now, or the theme's own colour when it has never said. */
    fun remembered(context: Context): Int {
        val fallback = context.getColor(R.color.page_bg)
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(key(context), fallback)
    }

    fun remember(context: Context, colour: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(key(context), colour).apply()
    }

    private fun key(context: Context): String {
        val night = context.resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return if (night) KEY_DARK else KEY_LIGHT
    }

    /* Relative luminance against the usual threshold. Decides whether the
       clock is drawn dark or light, and whether the loading screen's mark is
       inked dark or light. */
    fun isLight(colour: Int): Boolean = luminance(colour) > 0.5

    /* The ink for a mark drawn on this ground: the theme's page text colour
       when the ground agrees with the theme, and the other one when it does
       not. Black line art on a page the parent turned dark is invisible. */
    fun ink(colour: Int): Int = if (isLight(colour)) Color.parseColor("#0B0C0E") else Color.parseColor("#F7F8FA")

    /* Secondary text on the same ground: the ink at two thirds. */
    fun muted(colour: Int): Int {
        val i = ink(colour)
        return Color.argb(170, Color.red(i), Color.green(i), Color.blue(i))
    }

    private fun luminance(c: Int): Double {
        fun ch(v: Int): Double {
            val s = v / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(Color.red(c)) + 0.7152 * ch(Color.green(c)) + 0.0722 * ch(Color.blue(c))
    }

    /* What getComputedStyle hands back: `rgb(r, g, b)` or `rgba(r, g, b, a)`
       in every Chromium this app runs on; a hex form is accepted in case a
       future bundle reports its own token directly. A fully transparent
       answer is no answer. Anything else is refused rather than guessed,
       because a wrong bar colour is worse than the theme's. */
    fun parse(css: String): Int? {
        val s = css.trim()
        if (s.startsWith("#")) return runCatching { Color.parseColor(s) }.getOrNull()
        val m = RGB.find(s) ?: return null
        val r = m.groupValues[1].toDouble().toInt().coerceIn(0, 255)
        val g = m.groupValues[2].toDouble().toInt().coerceIn(0, 255)
        val b = m.groupValues[3].toDouble().toInt().coerceIn(0, 255)
        val a = m.groupValues[4].takeIf { it.isNotEmpty() }?.toDoubleOrNull() ?: 1.0
        if (a <= 0.0) return null
        return Color.rgb(r, g, b)
    }

    private val RGB = Regex(
        """rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)""",
    )
}
