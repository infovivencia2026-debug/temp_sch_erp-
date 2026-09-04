package com.schoolerp.parent

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.PorterDuff
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher

/* A SHELL AROUND THE SCHOOL'S OWN SITE, AND NOTHING MORE.

   No login of its own, no copy of any screen, no cached state to fall out of
   step with the server. Everything a parent sees here is the page the browser
   would have shown, which is the whole point: a fix shipped this afternoon
   reaches every installed app without anybody updating anything, and there is
   no second implementation of the fee screen to keep in step with the first.

   The argument against building this at all was real and is worth leaving
   written down: the portal is already responsive and already installable to
   the home screen from Chrome's own menu. What that argument missed is how a
   school actually distributes software. A link that must be opened in Chrome
   and then installed from a submenu is a step most families will not finish;
   an APK forwarded on WhatsApp is one they will.

   What a shell still has to do itself, because the site cannot: show that a
   page is loading, hand a downloaded receipt to the phone, survive its own
   renderer dying, and keep the page clear of the status bar. Each is here
   because leaving it out is a complaint.

   THE CONTROLS A WEBVIEW SILENTLY KILLS. That list grew. A bare WebView is
   not a browser; it is a rendering surface with most of a browser's chrome
   left out, and several ordinary HTML controls do nothing whatever in one
   until the host application volunteers to implement them. They do not fail,
   they do not warn, they simply do not respond, which is the worst way for
   anything to break because the parent concludes their phone is broken and
   there is nothing in any log to say otherwise. The file input was the
   expensive one and is dealt with at onShowFileChooser below. Anything else
   found in the same family belongs beside it rather than in a second class.
*/
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var pull: PullToRefresh
    private lateinit var web: WebView
    private lateinit var offline: View
    private lateinit var offlineTitle: TextView
    private lateinit var offlineBody: TextView
    private lateinit var offlineHint: TextView
    private lateinit var banner: TextView
    private lateinit var progress: ProgressBar

    /* The app's own loading screen, in front of the WebView until the page
       paints. See buildSplashView for what it carries and why it exists on
       top of the system splash the platform already gives us. */
    private lateinit var splash: View
    private lateinit var splashShot: ImageView

    /* WHAT WENT WRONG, KEPT APART FROM WHAT TO SAY ABOUT IT.

       A parent whose wifi is switched off and a parent whose school server is
       rebuilding are two different people with two different next actions, and
       the old panel told both of them the same sentence. Telling somebody with
       no signal that the school is down sends them to ring the office about a
       fault that does not exist; telling somebody in a 502 to check their data
       has them toggling aeroplane mode in a queue. So the failure is
       classified once, here, and every other decision reads the class. */
    private enum class Failure { NO_NETWORK, UNREACHABLE, SERVER }

    /* The last address that actually painted. Retry goes here rather than to
       the front door, and the cache fallback needs something to ask the cache
       for. */
    private var lastGoodUrl: String? = null

    /* True while a load has been deliberately aimed at the HTTP cache. The
       flag is what keeps the fallback from looping: a cache load that fails
       too comes back through onReceivedError with this set, and that is the
       point where there is genuinely nothing to show and the panel is right. */
    private var servingCache = false

    /* True once something out of the cache is on screen. It means the page in
       front of the parent is a snapshot from earlier, so when the network
       returns it is worth reloading under them rather than leaving them
       reading this morning's bus position as though it were live. */
    private var showingCached = false

    private var bannerAt = 0L

    /* Held so it can be unregistered. A callback left registered against a
       destroyed activity is a leak the system logs and then keeps calling. */
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    /* The page is waiting on this. Every path out of the chooser has to call
       it exactly once, including every failure and the plain cancel, or the
       input element stays disabled for the life of the page and the parent
       cannot even try again. */
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var pendingCapture: Uri? = null

    /* A download held over a permission prompt, and the ones already running.
       Kept because the completion broadcast carries an id and nothing else:
       without this the app would know a download had finished and not what it
       was called, where it was put, or whether the parent wanted to read it. */
    private class Pending(
        val url: String,
        val userAgent: String?,
        val disposition: String?,
        val mime: String?,
    )

    private class Started(
        val name: String,
        val mime: String,
        val toRead: Boolean,
        val public: Boolean,
    )

    /* Whether the app is on screen when a download finishes. Since Android 10
       an app in the background may not start an activity, so handing a
       finished PDF straight to a reader from a parent who has already switched
       to WhatsApp would be dropped by the system without a word. Backgrounded,
       the download provider's own notification is the right handover and this
       falls back to it. */
    private var foreground = false

    private var pending: Pending? = null
    private val started = mutableMapOf<Long, Started>()
    private var downloadWatcher: BroadcastReceiver? = null

    /* False until the web content has actually painted something. The system
       splash is held up against it; see holdSplash. */
    private var painted = false

    /* THE APP LOCK.

       A parent who turns it on (Profile → App lock in the portal) is asking
       the phone, not the school, to check it is them before the portal is
       shown again. When the app has been away for a minute or more the
       WebView is hidden behind this panel and the phone's own prompt is
       raised: fingerprint, face or the device PIN on Android 11 and up, the
       keyguard's confirm-credential screen on older phones. Nothing about
       the fingerprint ever reaches the site; the site is only told, through
       the bridge, whether the switch is on.

       Hidden rather than unloaded: the page and its session are left exactly
       where they were, so unlocking shows the screen the parent was on. */
    private lateinit var lock: View
    private var leftAt = 0L
    private var prompting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this).apply {
            /* targetSdk 35+ draws edge to edge whether asked or not. Without
               this the site's header sits under the clock and the bottom dock
               under the gesture bar, and the keyboard covers the field being
               typed into. The site's own safe-area CSS reads zero in a
               WebView, so the padding has to come from here.

               This is one of two possible answers and it is worth saying why
               it is this one. The alternative is to let the window stay edge
               to edge and let the page handle it: the site does set
               viewport-fit=cover and does use env(safe-area-inset-*) in its
               dock. The reason that does not work here is that env() only
               reports a non zero inset when the WebView is genuinely laid out
               underneath the system bars, which means the shell would have to
               stop padding, and then every screen that does NOT use the
               safe-area CSS, which is nearly all of them, would run under the
               clock. Padding natively is the answer that is correct for the
               whole site rather than for the one component that opted in.
               The two must not both be applied: with the root padded, env()
               correctly reads zero, so nothing is inset twice. */
            fitsSystemWindows = true
            setBackgroundColor(pageColor())
        }
        offline = buildOfflineView()
        offline.visibility = View.GONE
        lock = buildLockView()
        lock.visibility = View.GONE
        Shell.prefs = getSharedPreferences("shell", MODE_PRIVATE)
        Shell.files = filesDir
        Shell.canLock = canLock()
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        pull = PullToRefresh(this).apply {
            /* THE WEBVIEW IS THE WRONG THING TO ASK.
             *
             * `canScrollVertically` reports on the document, and this site
             * scrolls an element inside it: the dock is fixed and the shell
             * scrolls internally, so the document sits at zero on nearly every
             * screen no matter how far down the parent actually is. Asking the
             * WebView therefore answers "at the top" always, and the gesture
             * fired fifteen screens into the setup wizard and threw the page
             * back to the start. On a half-filled form that loses the form.
             *
             * PullToRefresh's own comment concluded there was no native answer
             * to this and the page would have to give up its inner scroller.
             * There is one, because we own the page as well: it reports where
             * its scroller is, and this reads the last thing it said. Kept as
             * a value rather than asked over the bridge because the question is
             * asked in ACTION_DOWN, where nothing may block, and
             * evaluateJavascript answers on another turn of the loop.
             *
             * Defaults to "not at the top", so a page that has not reported —
             * an old bundle, a screen still loading, a foreign origin — gets no
             * gesture rather than a gesture that reloads at the wrong moment.
             * Refusing is the safe direction: the cost is a missing
             * convenience, and the cost of the other default is lost work. */
            canScrollUp = { !shell.atTop }
            onRefresh = { web.reload() }
        }
        splash = buildSplashView()
        web = buildWebView()
        pull.addView(web, FrameLayout.LayoutParams(-1, -1))
        root.addView(pull, FrameLayout.LayoutParams(-1, -1))
        root.addView(offline, FrameLayout.LayoutParams(-1, -1))
        /* Above the page and the offline panel, below the lock: a parent who
           has asked for a fingerprint must not be shown a loading screen with
           yesterday's fees sitting behind it. */
        root.addView(splash, FrameLayout.LayoutParams(-1, -1))
        banner = buildBanner()
        root.addView(banner, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        root.addView(lock, FrameLayout.LayoutParams(-1, -1))
        root.addView(
            progress,
            FrameLayout.LayoutParams(-1, (4 * resources.displayMetrics.density).toInt(), Gravity.TOP),
        )
        allowCutout()
        setContentView(root)
        registerBack()
        watchNetwork()
        holdSplash()
        restoreLastScreen()

        /* restoreState hands back null when the saved bundle is unusable,
           which it is after the process was killed for long enough. Treating
           that as restored left a blank rectangle with no way out. */
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            load(deepLink(intent) ?: BuildConfig.PORTAL_URL)
        }
    }

    /* THE NOTCH, WHICH OTHERWISE COSTS A BLACK BAR.

       Left unstated, a phone with a cutout letterboxes this window in
       landscape: the whole page is pushed inboard of the notch and the strip
       beside it is painted black by the system, so a parent turning the phone
       sideways to read a wide fee table loses a centimetre of screen to a bar
       that carries nothing. SHORT_EDGES lets the window own that strip.

       This is only safe because the root already pads itself from the system
       window insets, and the cutout inset is one of them: the window extends
       under the notch, the content does not. The two lines belong together,
       and taking fitsSystemWindows off the root without taking this off would
       put the site's header behind the camera.

       The attribute could be set in the theme instead, but the theme is four
       files (light, dark, and the v31 pair) and this would have to be repeated
       in every one of them or silently not apply on the versions that matter
       most. One line here applies to all four. */
    private fun allowCutout() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode =
                android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    /* THE SPLASH, AND WHY THERE IS NO SPLASH SCREEN LIBRARY HERE.

       Android 12 and up show a system splash on every cold start whether the
       app asks for one or not, and by default it disappears the moment the
       first frame is drawn. For a shell that frame is an empty WebView: the
       page has not been fetched, parsed or painted yet. So the sequence a
       parent actually sees is icon, then an empty rectangle for as long as the
       network takes, then the portal. That empty rectangle is the single most
       recognisable tell that an app is a wrapper.

       androidx.core-splashscreen exists to fix exactly this and costs about
       50 KB plus androidx.core behind it. It is not used, because the whole of
       what it would be used for is the four lines below: the library's
       setKeepOnScreenCondition is a pre draw listener on the content view that
       returns false until a flag flips, which is what this is. The rest of the
       library is the compatibility shim for Android 11 and older, where there
       is no system splash to hold in the first place.

       The timeout is not decoration. Holding the splash on a condition that a
       slow or dead network never satisfies is how this technique turns into an
       app that appears to hang on a black screen with no way out, so the hold
       is capped.

       THE CAP USED TO BE FOUR SECONDS AND IS NOW A FIFTH OF THAT, because
       what the splash hands over to has changed. It used to hand over to an
       empty rectangle, so the longer it could be held the better; there is
       now an in-app loading screen behind it carrying the same mark, the last
       screen the parent was on, and a spinner that says the app is working.
       Holding a frozen system icon for four seconds when something better is
       ready underneath is not patience, it is a stall. Half a second is
       enough to swallow the handover on a warm start, where the page paints
       almost at once and an intermediate screen would be a flash of nothing;
       past that the parent is better served by the screen that moves. */
    private fun holdSplash() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val giveUpAt = System.currentTimeMillis() + 500
        root.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (!painted && System.currentTimeMillis() < giveUpAt) return false
                root.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
        // Nothing draws while the listener is refusing, so the flag has to be
        // released by something other than a frame. A posted message on the
        // main looper still runs.
        root.postDelayed({ painted = true; root.invalidate() }, 600)
    }

    @SuppressLint("SetJavaScriptEnabled")
    /* WHERE THE PAGE'S SCROLLER IS, as last reported.
     *
     * `@Volatile` because it is written on the JavaScript bridge's thread and
     * read on the UI thread inside a touch event. Without it the touch handler
     * may read a stale value indefinitely, which here means the gesture keeps
     * firing on a page the parent has already scrolled.
     *
     * Starts false — "not at the top" — so nothing is offered until the page
     * has actually said where it is. */
    private object Shell {
        /* The backing field is private and differently named, which is not
           style. `var atTop` compiles to a JVM setter called setAtTop, which
           collides with the bridge method of that name — the same trap
           PullToRefresh records for pullEnabled against View.setEnabled. Read
           through a val, so the generated accessor is getAtTop and there is
           nothing to clash with. */
        @Volatile private var reported: Boolean = false

        val atTop: Boolean get() = reported

        @android.webkit.JavascriptInterface
        fun setAtTop(value: Boolean) {
            reported = value
        }

        /* The app lock's switch. Still nothing but booleans: the page may
           turn the lock on or off and ask whether it is on and whether the
           phone can do it. It cannot raise the prompt, cannot read a result,
           and cannot reach anything else on the device. Bridge methods run
           on a WebView thread; SharedPreferences is safe from there. */
        lateinit var prefs: SharedPreferences
        @Volatile var canLock: Boolean = false

        /* The bridge runs off the UI thread and has no Context of its own;
           the activity hands it the private directory the picture lives in. */
        @Volatile var files: java.io.File? = null

        @android.webkit.JavascriptInterface
        fun setAppLock(on: Boolean) {
            prefs.edit().putBoolean("app_lock", on).apply()
            /* Turning the lock on has to take away the picture of the portal
               that is already on disk, not merely stop writing new ones.
               Otherwise the very next cold start shows, behind the unlock
               panel, the screen the lock was turned on to hide. */
            if (on) files?.let { LastScreen.clear(it) }
        }

        @android.webkit.JavascriptInterface
        fun appLockEnabled(): Boolean = prefs.getBoolean("app_lock", false)

        @android.webkit.JavascriptInterface
        fun biometricsAvailable(): Boolean = canLock

        /* THE PHONE ANSWERS A PRESS, FROM THE PHONE.

           The site asks for a tick under the thumb through navigator.vibrate,
           and in a WebView that is two disappointments. Chromium refuses the
           call until the document has been tapped once, so the first press
           after every load is silent; and what it does play is a bare motor
           pulse of 8 to 12 milliseconds, which on this class of handset is
           below what a thumb can feel. Measured on the S23: the call returned
           true and nothing happened that anybody would call a vibration.

           performHapticFeedback is what every native control uses. It plays
           the handset's own tuned click through the haptic engine, honours
           the person's touch-feedback setting, and needs no prior tap. The
           site calls this when it is present and falls back to the Vibration
           API in a browser. Bridge methods run on a WebView thread; a view
           is touched only from its own thread, hence the post. */
        @Volatile var target: View? = null

        @android.webkit.JavascriptInterface
        fun haptic(kind: String) {
            val view = target ?: return
            val constant = when (kind) {
                "warn" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.view.HapticFeedbackConstants.REJECT
                } else {
                    android.view.HapticFeedbackConstants.LONG_PRESS
                }
                "open" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.view.HapticFeedbackConstants.CONFIRM
                } else {
                    android.view.HapticFeedbackConstants.CONTEXT_CLICK
                }
                "select", "snap" -> android.view.HapticFeedbackConstants.CONTEXT_CLICK
                else -> android.view.HapticFeedbackConstants.CLOCK_TICK
            }
            view.post { view.performHapticFeedback(constant) }
        }
    }

    private val shell = Shell

    private fun buildWebView(): WebView {
        val view = WebView(this)
        with(view.settings) {
            // The site is a React app. Without this it is a blank rectangle.
            javaScriptEnabled = true
            domStorageEnabled = true
            // The session cookie has to survive the app being closed, or a
            // parent signs in every single time they open it, which is the
            // fastest way to make an app feel broken.
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            // Never mixed content: the portal is https and a page that quietly
            // pulls something over http is one that can be tampered with on a
            // shared wifi.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // The tiles, and everything else, may cache normally. An offline
            // parent still gets the last map they were shown rather than a
            // white screen.
            cacheMode = WebSettings.LOAD_DEFAULT
            /* NO PINCH ZOOM IN THE APP EITHER.

               The page asks for it with user-scalable=no, and a WebView
               obeys that only until something turns zoom on: setSupportZoom
               defaults to true, so a two-finger gesture could still leave the
               board at 1.4x with no way back that anybody finds. Turned off
               here as well so the page's own instruction is not the only thing
               holding the line.

               The product's answer to small text is the App text size slider
               in Settings, which reflows rather than magnifies, so this takes
               nothing away that is not replaced by something better. */
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            /* THE CACHE IS ONLY USEFUL IF SOMETHING ASKS FOR A STALE COPY.
               LOAD_DEFAULT obeys the response headers, and the portal serves
               its HTML no-cache, so a parent in a dead spot gets a white
               rectangle even though the whole bundle is sitting on the disk a
               centimetre away. Nothing here can change what the server sends,
               but the failure path can ask a different question: see
               fallBackToCache, which reloads under LOAD_CACHE_ELSE_NETWORK and
               so accepts entries that have expired. That is the difference
               between this morning's bus screen and nothing at all. */
        }
        view.setBackgroundColor(pageColor())
        applyDarkMode(view)
        suppressPointlessSelection(view)

        /* The one thing the page is allowed to tell the app.
         *
         * Deliberately a single boolean and nothing else. A JavascriptInterface
         * is a hole in the wall between a web page and the device, and every
         * method on it is reachable by whatever is running in that WebView; the
         * narrowest possible surface is the whole design. It cannot read, it
         * cannot navigate, it cannot open anything. It can say "my scroller is
         * at the top" and that is all it can say.
         *
         * Same-origin is enforced elsewhere — shouldOverrideUrlLoading sends
         * every foreign URL to a real browser — so the only code that can reach
         * this is the school's own bundle. */
        view.isHapticFeedbackEnabled = true
        Shell.target = view
        view.addJavascriptInterface(shell, "ErpShell")

        view.webViewClient = object : WebViewClient() {
            /* ANYTHING NOT THE SCHOOL OPENS IN A REAL BROWSER.

               A parent tapping the OpenStreetMap attribution, or a payment
               gateway, or a mailto link, must not end up inside a chrome-less
               window with no address bar and no way back. Keeping a foreign
               page inside this shell is also how a wrapper becomes a phishing
               surface: there is nothing on screen to say which site is which. */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                if (url.host != null && url.host == PORTAL_HOST) return false
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                }.getOrDefault(false)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                /* A tile or an avatar that failed is not a reason to replace a
                   working screen with an error, but it is worth a word: a
                   parent looking at a map with no tiles on it should be told
                   the phone is offline rather than left deciding the bus has
                   vanished. The banner goes away by itself. */
                if (!request.isForMainFrame) {
                    if (!hasNetwork() && web.visibility == View.VISIBLE) {
                        showBanner(getString(R.string.banner_offline))
                    }
                    return
                }
                failed(classify(error.errorCode))
            }

            /* The server answering with its own failure page is a deploy in
               progress or a fault, and a raw nginx 502 inside an app reads as
               the app being broken. Say what it is, and offer the retry that
               will work in a minute. */
            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (request.isForMainFrame && errorResponse.statusCode >= 500) {
                    failed(Failure.SERVER)
                }
            }

            /* Pixels on screen, which is a different and much earlier moment
               than onPageFinished: a React app finishes loading long after it
               has painted something worth looking at. Revealing here rather
               than at onPageFinished is what keeps the splash from handing
               over to an empty frame. */
            override fun onPageCommitVisible(view: WebView, url: String?) {
                painted = true
                hideSplash()
                committed(url)
                if (offline.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                painted = true
                hideSplash()
                progress.visibility = View.GONE
                pull.stopRefreshing()
                committed(url)
                if (offline.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            }

            /* The renderer is a separate process and the system kills it under
               memory pressure. Left unhandled that takes the whole app down,
               and the parent sees a crash for a page they were only reading.
               The old view is dead; the fix is a new one on the same URL. */
            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
                val url = view.url
                /* A chooser opened by the page that just died will never be
                   answered by anybody. Let it go now, or the next one cannot
                   open either. */
                deliverFiles(null)
                pull.removeView(view)
                view.destroy()
                web = buildWebView()
                pull.addView(web, 0, FrameLayout.LayoutParams(-1, -1))
                if (url != null) web.loadUrl(url) else load(BuildConfig.PORTAL_URL)
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.GONE
            }

            /* THE FILE INPUT, WHICH UNTIL NOW DID NOTHING AT ALL.

               Every document a school asks a family for arrives through an
               <input type="file"> on the portal: the birth certificate at
               admission, the transfer certificate, the bank slip against a fee,
               the photograph on a student record. In a WebView with no
               onShowFileChooser override, tapping one of those does not open a
               picker, does not raise an error and does not log a line. The tap
               simply lands and the app sits there. A parent has no way to tell
               that from a slow phone, so they tap it again, and eventually
               they ring the office and the office tells them to use a
               computer. That was the state of this app for every upload in it.

               The default WebChromeClient returns false from this method,
               which means "I am not handling it", and the WebView's answer to
               that is to do nothing. Returning true is a promise: the callback
               WILL be called, exactly once. Break that promise and the input
               element stays permanently disabled, so a parent who cancels the
               picker cannot even reach it again without reloading the page.
               Every branch below therefore ends in deliverFiles, cancel
               included, and the result handler covers the case where the
               parent leaves the picker with the back gesture, which produces
               RESULT_CANCELED and no data at all. */
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                /* A chooser already open means the previous one was abandoned
                   without a result, usually because the page navigated. Answer
                   it before replacing it, so its input is not left dead. */
                deliverFiles(null)
                pendingFiles = callback
                pendingCapture = null

                val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                val accept = params.acceptTypes.filter { it.isNotBlank() }
                val mimes = accept.map(::toMime).distinct()

                /* THE CAMERA IS THE COMMON PATH, NOT THE EXOTIC ONE. A parent
                   asked for a birth certificate does not have a scan of it in
                   their downloads folder; they have the paper in their hand.
                   An upload flow that can only reach the file system is one
                   most families cannot complete at all, so the camera has to
                   be offered next to the files rather than buried.

                   NOTE ON PERMISSIONS, BECAUSE THE OBVIOUS BELIEF IS WRONG.
                   Firing ACTION_IMAGE_CAPTURE needs no CAMERA permission: the
                   photograph is taken by the camera app, under its own
                   identity, and this app only receives the result. Worse, the
                   documented behaviour is that if an app DECLARES the CAMERA
                   permission in its manifest and has not been granted it, the
                   same intent throws a SecurityException. So the manifest
                   deliberately does not declare it, and there is deliberately
                   no runtime permission prompt here. Adding either would be
                   asking a parent to grant something in order to enable a
                   failure mode that does not otherwise exist. */
                val camera = if (params.isCaptureEnabled || allowsImages(mimes)) cameraIntent() else null

                if (params.isCaptureEnabled && camera != null) {
                    // The page asked for the camera specifically. Do not make
                    // the parent pick "camera" out of a chooser first.
                    return launch(camera)
                }

                val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    /* The accept attribute, honoured rather than ignored. A
                       screen that asks for a CSV and is shown every photo on
                       the phone is a screen the parent will get wrong. One
                       type goes in setType; several have to go through
                       EXTRA_MIME_TYPES with a wildcard type, because setType
                       takes exactly one and the wildcard alone would show
                       everything. */
                    if (mimes.size == 1) {
                        type = mimes[0]
                    } else {
                        type = "*/*"
                        if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
                    }
                    // The multiple attribute, likewise. Without this a page
                    // asking for several attachments gets exactly one and no
                    // explanation.
                    if (multiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }

                val chooser = Intent.createChooser(pick, getString(R.string.choose_file)).apply {
                    if (camera != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
                }
                return launch(chooser)
            }
        }

        /* THE TAP THAT DID NOTHING, AND THE ONE THAT SHOWED A BLANK PAGE.

           Two different failures arrive at this one callback and they need
           different endings.

           An attachment is the receipt and the circular: the server sends
           Content-Disposition attachment, Chromium refuses to render it, and a
           WebView with no DownloadListener drops it on the floor without a
           sound. The parent taps the receipt, nothing happens, they tap it
           again, and eventually they ring the office.

           An inline PDF is the same silence wearing a different coat. The
           portal frames attachments with ?inline=1 so a worksheet can be read
           without saving a copy of a school record forever, which is right in
           a browser and impossible here: Android's WebView carries no PDF
           renderer at all, so Chromium cannot paint it and turns the
           navigation into a download instead. That lands here too, and if it
           is only filed away the parent is left staring at an empty frame
           where their child's circular should be.

           So the disposition decides the ending. Attachment: save it and say
           where it went. Inline: save it and then hand it to whatever on the
           phone can actually show a PDF, because the parent asked to read it,
           not to keep it. */
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        }
        return view
    }

    /* THE PAGE FOLLOWS THE PHONE'S DARK SETTING, WHICH IT DID NOT.

       The portal styles itself from prefers-color-scheme and gets it right in
       a browser. Inside a WebView that media query does not read the phone's
       setting at all: it reads whether the WebView believes it is being drawn
       on a dark ground, and nothing here had ever told it. So a parent whose
       phone had been in dark mode all evening opened this and got a white fee
       screen inside a black frame, which is both a glare in a dark room and
       the most obvious possible tell that the app is a page in a box.

       Two different mechanisms, because the platform changed the answer under
       us and this app still runs on Android 7.

       From Android 13 the WebView derives prefers-color-scheme from the host
       theme's android:isLightTheme, so the fix there is in themes.xml and
       values-night/themes.xml rather than here, and it is stated explicitly in
       both rather than inherited from the Material parent: inheriting it
       happens to be correct today and would stop being correct the moment
       somebody changed a parent theme, with nothing to connect the two.

       Before that, the only lever is FORCE_DARK. The name is alarming and the
       usual objection to it is right in general and wrong here: it only
       inverts colours algorithmically on a page that has NOT said it can do
       dark itself. This page has, through color-scheme and the media query, so
       what FORCE_DARK_ON buys on those versions is exactly the one thing
       wanted, the query matching, and none of the mangling. Set only when the
       phone is actually in dark mode, so a light phone is never darkened.

       WebSettingsCompat.setAlgorithmicDarkeningAllowed is the AndroidX way to
       say all of this in one line. It costs androidx.webkit and the version
       train behind it, for a line that is already covered by the two branches
       here on every version this app supports. */
    private fun applyDarkMode(view: WebView) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
        val night = resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        @Suppress("DEPRECATION")
        view.settings.forceDark =
            if (night) WebSettings.FORCE_DARK_ON else WebSettings.FORCE_DARK_OFF
    }

    /* LONG PRESS ON A BUS PIN SHOULD NOT OFFER TO COPY IT.

       A WebView's default long press is the browser's, minus the browser. Hold
       a finger anywhere and it raises the text selection handles and the
       Copy/Share/Web-search bar, including on things that are not text at all:
       the map on the bus screen, an avatar, a fee row's icon, the dock. On the
       bus screen in particular this is a real cost rather than an untidiness,
       because holding a finger on the map is how a person drags it, and every
       drag that started as a hold came back with a selection bar over the top
       of the thing they were trying to look at.

       What makes it worse in a shell is that the callout's actions largely go
       nowhere here: there is no tab to open a link in, and the search action
       leaves the app entirely. So the press is refused for the cases where the
       result cannot be useful, and allowed for the two where it plainly is.

       Refused: images, and links, whose long press in a bare WebView offers a
       menu this app does not implement. Allowed: an editable field, where the
       handles are the only way to fix a mis-typed phone number, and the plain
       text case, which the hit test reports as UNKNOWN because a paragraph is
       not a distinct element to it. That last one is why this is not simply
       isLongClickable = false: switching selection off wholesale would take
       with it the ability to copy a receipt number or a circular out of the
       page, which parents do. */
    private fun suppressPointlessSelection(view: WebView) {
        view.setOnLongClickListener {
            when (view.hitTestResult.type) {
                WebView.HitTestResult.IMAGE_TYPE,
                WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE,
                WebView.HitTestResult.SRC_ANCHOR_TYPE,
                -> true
                else -> false
            }
        }
    }

    /* THE DOWNLOAD, FROM THE TAP TO THE FILE THE PARENT CAN STILL FIND
       NEXT MONTH.

       WHY THE COOKIE IS ATTACHED BY HAND. DownloadManager is a separate system
       service with its own network stack and its own cookie jar, which is
       empty. Every file worth downloading here is behind the login, so a
       request sent without the session cookie comes back as the sign in page,
       and the parent ends up with a receipt-shaped file containing HTML. The
       cookie has to be lifted out of the WebView's jar and put on the request.

       WHY THE PUBLIC DOWNLOADS FOLDER RATHER THAN THE APP'S OWN. A fee receipt
       is kept in order to be produced later: forwarded on WhatsApp, shown at
       the office, attached to something. A file in the app's private external
       directory is invisible to the Files app, invisible to every share sheet,
       and deleted when the app is uninstalled. That is not keeping a receipt,
       it is holding one until the phone changes its mind. */
    private fun startDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val uri = runCatching { Uri.parse(url) }.getOrNull()
        val scheme = uri?.scheme?.lowercase()

        /* blob: and data: are not addresses, they are content the page is
           holding in memory, and DownloadManager cannot fetch either: handing
           it one fails with an exception rather than a file. The portal does
           not generate them today, so rather than carry a JavaScript bridge to
           haul bytes back out of the page for a case that does not exist, this
           says so out loud. A sentence the parent can act on beats the silence
           this whole listener exists to end. */
        if (uri == null || (scheme != "https" && scheme != "http")) {
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show()
            return
        }

        /* Anything not the school goes to a real browser, for the same reason
           shouldOverrideUrlLoading sends foreign pages there: the session
           cookie is this origin's and must not be posted to another host, and
           a download the parent did not expect is better explained by a
           browser that has an address bar. */
        if (uri.host != PORTAL_HOST) {
            val opened = runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)); true }
                .getOrDefault(false)
            if (!opened) Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show()
            return
        }

        val name = fileName(url, contentDisposition, mimeType)
        /* "inline" is the portal asking for this to be READ rather than kept:
           see the note on the listener. Anything else, including a header we
           could not parse, is treated as a keepsake, which is the safer of the
           two mistakes: an unwanted file in Downloads is a nuisance, an
           unwanted app launch is a hijacked phone. */
        val toRead = contentDisposition?.trimStart()?.startsWith("inline", ignoreCase = true) == true

        /* Asked for only at the moment it is needed and only where it is still
           a real permission: see the manifest note. A parent who says no is
           not asked again and is not blocked, the file simply lands somewhere
           less useful and the wording at the end says so rather than promising
           a Downloads folder that has nothing in it. */
        if (needsStoragePermission() && !hasStoragePermission()) {
            pending = Pending(url, userAgent, contentDisposition, mimeType)
            runCatching {
                requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_STORAGE)
            }.onFailure { enqueue(uri, userAgent, name, mimeType, toRead) }
            return
        }
        enqueue(uri, userAgent, name, mimeType, toRead)
    }

    private fun enqueue(
        uri: Uri,
        userAgent: String?,
        name: String,
        mimeType: String?,
        toRead: Boolean,
    ) {
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        if (dm == null) {
            Toast.makeText(this, getString(R.string.download_failed, name), Toast.LENGTH_LONG).show()
            return
        }
        val type = mimeType?.takeIf { it.isNotBlank() } ?: guessMime(name)
        val request = DownloadManager.Request(uri).apply {
            setMimeType(type)
            userAgent?.let { addRequestHeader("User-Agent", it) }
            CookieManager.getInstance().getCookie(uri.toString())
                ?.let { addRequestHeader("Cookie", it) }
            setTitle(name)
            setDescription(getString(R.string.app_name))
            /* The system's own notification is the parent's way back to the
               file after the toast has gone, and it opens the file when
               tapped. It is posted by the download provider under its own
               identity, which is why POST_NOTIFICATIONS is not declared here:
               see the manifest. */
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        }

        /* Two destinations and one fallback. The public folder is the point;
           it throws when external storage is not mounted, and on the phones
           where the permission above was refused it produces a file nobody
           can read. Falling back to the app's own external directory keeps the
           download working in both cases, and `saved` records which of the two
           happened so the parent is told the truth about where to look. */
        var public = true
        runCatching {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        }.onFailure {
            public = false
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
        }
        if (public && needsStoragePermission() && !hasStoragePermission()) {
            public = false
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
        }

        val id = runCatching { dm.enqueue(request) }.getOrNull()
        if (id == null) {
            Toast.makeText(this, getString(R.string.download_failed, name), Toast.LENGTH_LONG).show()
            return
        }
        started[id] = Started(name, type, toRead, public)
        watchDownloads()
        /* Said at the start as well as at the end, because on the mobile data
           this app is built for the two are half a minute apart and a tap that
           acknowledges nothing for half a minute is a tap that gets repeated. */
        Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
    }

    /* WHERE IT WENT, ONCE IT IS ACTUALLY THERE.

       The toast at the start is a promise and this is the receipt for it. It
       matters most in the case the start toast cannot cover: a download that
       fails halfway, on a connection that drops, would otherwise leave the
       parent believing they have a copy of a fee receipt that does not exist.

       Registered lazily and only once, because a parent who never downloads
       anything should not be paying for a registered receiver, and torn down
       in onDestroy so it does not outlive the activity it toasts from. */
    private fun watchDownloads() {
        if (downloadWatcher != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: -1L
                val record = started.remove(id) ?: return
                finished(id, record)
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        runCatching {
            /* The broadcast comes from the download provider, so on Android 14
               and up the receiver has to say it accepts broadcasts from other
               apps. Without the flag the platform throws at registration
               rather than merely never delivering, which would take the app
               down on the first download. */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                registerReceiver(receiver, filter)
            }
        }.onSuccess { downloadWatcher = receiver }
    }

    private fun finished(id: Long, record: Started) {
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager ?: return
        val status = runCatching {
            dm.query(DownloadManager.Query().setFilterById(id)).use { c ->
                if (c != null && c.moveToFirst()) {
                    c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                } else {
                    DownloadManager.STATUS_FAILED
                }
            }
        }.getOrDefault(DownloadManager.STATUS_FAILED)

        if (status != DownloadManager.STATUS_SUCCESSFUL) {
            Toast.makeText(
                this,
                getString(R.string.download_failed, record.name),
                Toast.LENGTH_LONG,
            ).show()
            return
        }

        // The parent asked to read this, not to file it. Try to show it.
        if (record.toRead && foreground && openDownloaded(dm, id, record)) return

        Toast.makeText(
            this,
            getString(
                if (record.public) R.string.download_saved else R.string.download_saved_app,
                record.name,
            ),
            Toast.LENGTH_LONG,
        ).show()
    }

    /* A PDF handed to something that can draw one.

       getUriForDownloadedFile answers with a content:// Uri from the downloads
       provider rather than a path, which is the only shape another app may be
       given since Android 7, and the read grant travels with the intent. False
       when there is nothing on the phone that will take it, and the caller
       then falls back to saying where the file is, because a parent who can be
       told "it is in Downloads" can still open it from the Files app. */
    private fun openDownloaded(dm: DownloadManager, id: Long, record: Started): Boolean {
        val uri = runCatching { dm.getUriForDownloadedFile(id) }.getOrNull() ?: return false
        val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, record.mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return runCatching { startActivity(view); true }.getOrDefault(false)
    }

    /* WRITE_EXTERNAL_STORAGE IS ONLY A PERMISSION ON THE OLD HALF OF THE RANGE.

       This app runs from API 24 to 36. On API 28 and below, writing into the
       shared Downloads folder is a genuine permission and DownloadManager will
       refuse without it. From API 29 the folder is not the app's to write at
       all: DownloadManager files it through MediaStore on the app's behalf and
       the permission was removed from the platform, so asking for it there
       would raise a dialog the system then ignores. Hence the ceiling here and
       the matching maxSdkVersion in the manifest: on a modern phone the parent
       is asked for nothing whatever. */
    private fun needsStoragePermission(): Boolean =
        Build.VERSION.SDK_INT <= Build.VERSION_CODES.P

    private fun hasStoragePermission(): Boolean =
        checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_STORAGE) return
        /* Granted or refused, the download goes ahead: enqueue reads the
           permission again and picks the destination it can actually write.
           Dropping the tap on a refusal would put us back where this whole
           change started, with a control that does nothing. */
        val next = pending ?: return
        pending = null
        val uri = runCatching { Uri.parse(next.url) }.getOrNull() ?: return
        enqueue(
            uri,
            next.userAgent,
            fileName(next.url, next.disposition, next.mime),
            next.mime,
            next.disposition?.trimStart()?.startsWith("inline", ignoreCase = true) == true,
        )
    }

    /* WHAT TO CALL THE FILE.

       URLUtil.guessFileName is the obvious answer and it is not enough here,
       because its Content-Disposition parser matches "attachment" and nothing
       else. The portal's inline responses say `inline; filename="..."`, so
       every circular a parent opened to read would fall back to the URL, and
       the URL for an attachment on this site is /api/v1/files/<uuid>: the
       parent's Downloads folder would fill with files named after uuids.

       filename* comes first because that is the encoded form and the one that
       carries a name in Telugu or Hindi correctly; a school circular is
       routinely titled in the local language. */
    private fun fileName(url: String, disposition: String?, mime: String?): String {
        val header = disposition?.let { d ->
            EXTENDED.find(d)?.groupValues?.get(1)?.let { raw ->
                runCatching { java.net.URLDecoder.decode(raw, "UTF-8") }.getOrNull()
            } ?: QUOTED.find(d)?.groupValues?.get(1) ?: PLAIN.find(d)?.groupValues?.get(1)
        }
        val name = header?.takeIf { it.isNotBlank() }
            ?: runCatching { URLUtil.guessFileName(url, disposition, mime) }.getOrNull()
            ?: "download"
        return safeName(name, mime)
    }

    /* A NAME THE FILE SYSTEM WILL TAKE AND THE HEADER CANNOT AIM.

       The name arrives from a response header, which means it is server input
       and, on a system that stores uploaded filenames, ultimately something
       somebody typed. A slash in it would send the write out of the Downloads
       folder, so the path separators are stripped before anything else and
       what is left is reduced to characters a phone will display and a share
       sheet will not mangle. */
    private fun safeName(raw: String, mime: String?): String {
        val base = raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("""[^A-Za-z0-9._ ()\u0080-\uFFFF-]"""), "_")
            .trimStart('.')
            .trim()
            .take(100)
        val name = base.ifBlank { "download" }
        if (name.contains('.')) return name
        // A file with no extension is one the phone offers no app for, which
        // after all this work is a saved receipt the parent cannot open.
        val ext = mime?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
        return if (ext != null) "$name.$ext" else name
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    /* A phone with no document picker and no camera is rare but real, and on
       one of them startActivityForResult throws. Falling through that
       exception would leave the promise to the WebView unkept, so the failure
       is caught, the page is told plainly that nothing was chosen, and the
       parent is told out loud rather than left watching a control that does
       not respond. */
    private fun launch(intent: Intent): Boolean {
        return try {
            startActivityForResult(intent, REQUEST_FILES)
            true
        } catch (_: ActivityNotFoundException) {
            deliverFiles(null)
            Toast.makeText(this, R.string.no_picker, Toast.LENGTH_LONG).show()
            true
        }
    }

    private fun cameraIntent(): Intent? {
        val uri = PickedFileProvider.newImageUri(this) ?: return null
        val take = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        /* Package visibility on Android 11 and up hides every app this one has
           not declared an interest in, so without the <queries> block in the
           manifest this resolve returns null on a phone that plainly does have
           a camera, and the camera silently disappears from the chooser. */
        if (take.resolveActivity(packageManager) == null) return null
        take.putExtra(MediaStore.EXTRA_OUTPUT, uri)
        take.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        /* The flags above are the documented way to grant access to the output
           Uri, and several OEM camera apps do not honour them on the
           EXTRA_OUTPUT extra. Granting explicitly to every app that could
           answer the intent costs nothing and is the difference between a
           photo and a "couldn't save" toast on those handsets. The grant is
           revoked when this activity's task finishes. */
        runCatching {
            packageManager.queryIntentActivities(take, 0).forEach {
                grantUriPermission(
                    it.activityInfo.packageName,
                    uri,
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
        }
        pendingCapture = uri
        return take
    }

    /* The accept attribute is written by whoever wrote the page and comes
       through in whatever form HTML allows: a real mime type, a wildcard, or
       an extension like ".csv", which the intent system does not understand at
       all. An unmapped extension has to become a wildcard rather than be
       passed through, because a picker given a filter it cannot parse shows an
       empty list, and an empty picker reads as a phone with no files on it. */
    private fun toMime(accept: String): String {
        val value = accept.trim()
        if (!value.startsWith(".")) return if (value.contains("/")) value else "*/*"
        val ext = value.removePrefix(".").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
    }

    /* An empty accept means the page will take anything, and a photograph is
       something. Offering the camera then is right; offering it against a
       page that asked for a CSV is noise in the chooser. */
    private fun allowsImages(mimes: List<String>): Boolean =
        mimes.isEmpty() || mimes.any { it == "*/*" || it.startsWith("image/") }

    /* The one place the promise to the WebView is kept, so it is kept exactly
       once. Calling the callback twice is not merely untidy: the second call
       lands on a page that has already moved on and has thrown WebView
       internals in the past. */
    private fun deliverFiles(uris: Array<Uri>?) {
        val callback = pendingFiles ?: return
        pendingFiles = null
        callback.onReceiveValue(uris)
    }

    @Deprecated("Platform Activity has no ActivityResultLauncher; see the note below.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_UNLOCK) {
            prompting = false
            if (resultCode == RESULT_OK) unlocked()
            return
        }
        if (requestCode != REQUEST_FILES) return

        /* THE REGISTERFORACTIVITYRESULT QUESTION, ANSWERED IN THE NEGATIVE.
           ActivityResultLauncher is an AndroidX API and lives on
           ComponentActivity. Reaching it means androidx.activity, and
           androidx.activity means lifecycle, core and the rest, in an app
           whose whole design note is that it depends on nothing. What the
           launcher buys over this is protection against the process being
           killed while the picker is in front, and that case is already lost
           here for a different reason: the ValueCallback the WebView handed us
           belongs to a page that will not survive that either. So the
           deprecated pair is the honest choice, and the deprecation is
           suppressed rather than worked around. */

        val capture = pendingCapture
        pendingCapture = null

        if (resultCode != Activity.RESULT_OK) {
            // Cancelled, or the camera app died. Either way the page is told
            // nothing was chosen, which re-enables the input.
            deliverFiles(null)
            return
        }

        /* A camera result usually carries no data at all: the photo went to
           the Uri we supplied. A zero length file means the camera app
           returned OK without writing anything, which some do when storage is
           full, and handing that to the page would upload an empty file that
           the office would later have to chase. */
        if (data == null || (data.data == null && data.clipData == null)) {
            if (capture == null) {
                deliverFiles(null)
                return
            }
            val written = runCatching {
                contentResolver.openInputStream(capture)?.use { it.read() != -1 } == true
            }.getOrDefault(false)
            deliverFiles(if (written) arrayOf(capture) else null)
            if (!written) Toast.makeText(this, R.string.capture_failed, Toast.LENGTH_LONG).show()
            return
        }

        // Multiple selection arrives in clipData, a single one in data. Both
        // shapes have to be read, because which one appears depends on the
        // picker rather than on what was asked for.
        val clip = data.clipData
        val uris = when {
            clip != null -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
            else -> listOfNotNull(data.data)
        }
        deliverFiles(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    /* A LINK IN A MESSAGE THAT OPENS THE APP AT THE THING IT NAMES.

       Schools send fee reminders and circulars by SMS and email with a link in
       them, and until now that link opened a browser even on a phone with this
       app installed. The parent then met the sign in page a second time, in a
       different place, with a different session, which is exactly the
       confusion the app was supposed to remove.

       The manifest claims a deliberately narrow slice of the site rather than
       the host: see the note there. Whatever it does claim can arrive either
       as a cold start, handled in onCreate, or at an activity that is already
       running, handled here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = deepLink(intent) ?: return
        hideBanner()
        load(url)
    }

    /* Only ever a link into the portal itself. An activity is reachable by any
       app on the phone that can build an intent, so a URL arriving here is
       untrusted input: without this check another app could point this shell
       at a page of its choosing, and a parent would see it inside something
       carrying the school's icon and name. That is the whole phishing surface
       the shouldOverrideUrlLoading note is about, opened from the other end. */
    private fun deepLink(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_VIEW) return null
        val data = intent.data ?: return null
        if (data.scheme != "https" || data.host != PORTAL_HOST) return null
        return data.toString()
    }

    private fun load(url: String) {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        /* showOffline switches the gesture off while its panel is up. Every
           path back to a live page has to switch it on again, or a parent who
           met one error keeps a page they can no longer pull to refresh for
           the rest of the session. */
        pull.pullEnabled = false // pull-to-refresh is off: the swipe reloaded the app mid-form
        web.loadUrl(url)
    }

    /* Retry goes back to the page that failed, not to the front door. A
       parent who lost signal on the fee screen wants the fee screen. */
    private fun retry() {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        pull.pullEnabled = false
        servingCache = false
        showingCached = false
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        val url = lastGoodUrl ?: web.url
        if (url != null) web.loadUrl(url) else load(BuildConfig.PORTAL_URL)
    }

    /* A load that painted. Worth recording where it was, and worth clearing
       whatever the last failure put on screen. */
    private fun committed(url: String?) {
        if (url != null && url != "about:blank") lastGoodUrl = url
        /* A live page clears the stale flag.

           It was only ever cleared inside the servingCache branch below, so
           once a cached copy had been shown the app went on believing it was
           still showing one: every later navigation, on a perfectly good
           connection, was treated as stale, and the network callback kept
           reloading pages a parent was reading. The flag describes what is on
           screen now, and what is on screen now is this page. */
        if (!servingCache) showingCached = false
        if (servingCache) {
            /* The cached copy is what is now in front of the parent. Say so:
               a stale fee balance presented as current is worse than no fee
               balance, because it is believed. */
            servingCache = false
            showingCached = true
            web.settings.cacheMode = WebSettings.LOAD_DEFAULT
            showBanner(
                getString(if (hasNetwork()) R.string.banner_slow else R.string.banner_offline),
            )
        }
    }

    /* WHICH OF THE THREE THINGS WENT WRONG.

       The WebView reports a transport level code and nothing about the phone,
       so the code alone cannot tell "the wifi is off" from "the school's box
       is not answering": both arrive as a failure to connect or to resolve a
       name. The connectivity manager is the other half of the question, and it
       is asked first, because a phone with no network explains every code
       there is and is the one case where the parent can actually do
       something. */
    private fun classify(errorCode: Int): Failure {
        if (!hasNetwork()) return Failure.NO_NETWORK
        /* Everything that reaches here happened with a network present, so it
           is the site that could not be had: a name that would not resolve, a
           connection refused, a request that timed out. They are one sentence
           to a parent, who cannot act differently on any of them, so they are
           one class. The code is kept in the signature because the log line
           below is the only place the distinction has ever been useful. */
        android.util.Log.i("ParentShell", "main frame failed, code " + errorCode)
        return Failure.UNREACHABLE
    }

    /* THE MAIN FRAME FAILED, AND THE PANEL IS THE LAST ANSWER RATHER THAN THE
       FIRST.

       Order matters here and it is the whole point of this change. Replacing a
       screen the parent can read with a full page error is a worse outcome
       than the error, so the first thing tried is the disk: reload the same
       address through the HTTP cache, which on a phone that opened the bus
       screen this morning still holds the bundle. Only when that comes back
       empty as well is there genuinely nothing to show, and only then does the
       panel appear. */
    private fun failed(kind: Failure) {
        if (!servingCache && lastGoodUrl != null) {
            fallBackToCache()
            return
        }
        showOffline(kind)
    }

    private fun fallBackToCache() {
        val url = lastGoodUrl ?: return
        servingCache = true
        progress.visibility = View.GONE
        pull.stopRefreshing()
        /* ELSE_NETWORK rather than CACHE_ONLY: it serves entries whose
           freshness has expired, which is nearly all of them given the portal
           sends its HTML no-cache, and still reaches the network for anything
           missing when there is a network to reach. CACHE_ONLY would fail
           outright the moment one sub resource had been evicted. */
        web.settings.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
        web.loadUrl(url)
    }

    private fun showOffline(kind: Failure) {
        progress.visibility = View.GONE
        // An error the parent can act on beats a spinner that will not end.
        hideSplash()
        // Whatever was holding the splash, this is the thing worth showing.
        painted = true
        /* A pull that started this load has to be released here as well as on
           success, or a parent who pulls to refresh in a tunnel is left with a
           spinner that never stops on top of an error that explains itself. */
        pull.stopRefreshing()
        // The panel has its own retry button; a second, invisible way to do
        // the same thing behind it is not an improvement.
        pull.pullEnabled = false
        servingCache = false
        showingCached = false
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        hideBanner()
        offlineTitle.text = getString(
            when (kind) {
                Failure.NO_NETWORK -> R.string.offline_title
                Failure.UNREACHABLE -> R.string.unreachable_title
                Failure.SERVER -> R.string.server_title
            },
        )
        offlineBody.text = getString(
            when (kind) {
                Failure.NO_NETWORK -> R.string.offline_body
                Failure.UNREACHABLE -> R.string.unreachable_body
                Failure.SERVER -> R.string.server_body
            },
        )
        /* Only promised where it can be kept. The network callback fires when
           a network appears, so a parent who has switched their data off will
           see this reload itself the moment they switch it back; a parent
           whose school server is down has a network already and nothing will
           fire, so they are not told to wait for something that will not
           happen. */
        offlineHint.visibility = if (kind == Failure.NO_NETWORK) View.VISIBLE else View.GONE
        web.visibility = View.GONE
        offline.visibility = View.VISIBLE
    }

    /* THE BANNER, WHICH IS THE POINT OF NOT USING THE PANEL.

       One line over the top of a page that still works, gone in a few seconds.
       It is dismissible by tapping because it sits over the site's own header,
       and four seconds of a covered header on a screen the parent is trying to
       read is its own small annoyance. */
    private fun showBanner(text: String) {
        banner.text = text
        banner.visibility = View.VISIBLE
        val shownAt = SystemClock.elapsedRealtime()
        bannerAt = shownAt
        banner.postDelayed({ if (bannerAt == shownAt) hideBanner() }, BANNER_MS)
    }

    private fun hideBanner() {
        bannerAt = 0L
        banner.visibility = View.GONE
    }

    private fun buildBanner(): TextView {
        val pad = (12 * resources.displayMetrics.density).toInt()
        return TextView(this).apply {
            visibility = View.GONE
            setPadding(pad, pad, pad, pad)
            textSize = 14f
            setBackgroundColor(getColor(R.color.banner_bg))
            setTextColor(getColor(R.color.banner_text))
            // Otherwise the tap goes through to whatever the site has under
            // the banner, which on the bus screen is the map.
            isClickable = true
            setOnClickListener { hideBanner() }
        }
    }

    /* NOBODY SHOULD HAVE TO KEEP PRESSING A BUTTON.

       The parent this app is for is on mobile data in Hanumakonda, which comes
       and goes on its own several times in a thirty second visit. The old
       panel sat there until somebody tapped it, so the common shape of the
       failure was: signal returns, app still shows an error, parent concludes
       the app is broken rather than the network was.

       registerDefaultNetworkCallback fires when a usable default network
       appears, which is the exact moment the retry is worth making. It is
       registered for the life of the activity rather than per failure: the
       callback is cheap, and registering it only after a failure means missing
       the network that came back while the panel was being built. */
    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Callbacks arrive on a binder thread; every view below is the
                // UI thread's.
                runOnUiThread { networkReturned() }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(callback) }
            .onSuccess { netCallback = callback }
    }

    private fun networkReturned() {
        if (isFinishing || isDestroyed) return
        if (offline.visibility == View.VISIBLE) {
            retry()
            return
        }
        /* A stale snapshot with the network back is worth quietly replacing:
           the whole reason it is on screen is that the live page could not be
           had. Anything else that is already live is left alone, because
           reloading a page a parent is reading to tell them nothing new is
           worse than saying nothing. */
        if (showingCached) {
            showingCached = false
            showBanner(getString(R.string.banner_back))
            web.settings.cacheMode = WebSettings.LOAD_DEFAULT
            web.reload()
        }
    }

    private fun hasNetwork(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        /* VALIDATED is deliberately not required. A captive portal or a cell
           connection the system has not finished probing reports INTERNET
           without it, and calling that "no connection" sends a parent to
           check a wifi switch that is already on. */
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /* THE TEN SECONDS THIS APP IS ACTUALLY JUDGED ON.

       The system splash covers the launch and nothing else. Everything after
       it, which on the mobile data in Hanumakonda is most of the wait, was a
       flat coloured rectangle: the React bundle has to come down the wire,
       parse and boot before the WebView has a single pixel to show. A parent
       cannot tell that rectangle from an app that has hung, and the thing
       they do about an app that has hung is press it again.

       So the rectangle carries three things instead. The school's mark, which
       is the same mark the system splash just showed and the same one on the
       home screen, so the handover looks like one screen rather than three.
       A spinner, because a still picture cannot say "working" and motion can.
       And, behind both, the last screen this parent was on, dimmed: see
       LastScreen for what that is and when it is refused.

       All of it is drawn on the page's own background colour, so whichever of
       these is up there is never a change of colour anywhere in the sequence.
       That is the whole trick: the eye reads a colour change as a new screen
       and reads no colour change as one screen filling in.

       Native rather than an HTML file loaded first, which is the other way to
       do this. A local page would still need the WebView to start, parse and
       paint, which is a good part of the delay being covered, and it would put
       a second loading screen in the repository to keep in step with the
       first. */
    private fun buildSplashView(): View {
        val density = resources.displayMetrics.density
        splashShot = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            /* Faint on purpose. It has to read as the memory of a screen
               rather than as the screen: nothing on it responds to a tap, and
               a parent who believed it was live would tap a fee row and get
               nothing. At a third of its opacity it is scenery. */
            alpha = 0.3f
            visibility = View.GONE
        }
        val mark = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher_foreground)
            /* The launcher foreground is white line art drawn to sit on its
               own dark ground. Dropped unchanged onto the light page colour
               it is invisible, so it is tinted to the ink of whichever theme
               is up. */
            setColorFilter(getColor(R.color.splash_mark), PorterDuff.Mode.SRC_IN)
        }
        val markSize = (128 * density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(mark, LinearLayout.LayoutParams(markSize, markSize))
            addView(
                ProgressBar(context).apply { isIndeterminate = true },
                LinearLayout.LayoutParams(
                    (32 * density).toInt(),
                    (32 * density).toInt(),
                ).apply { topMargin = (8 * density).toInt() },
            )
        }
        return FrameLayout(this).apply {
            setBackgroundColor(pageColor())
            /* Swallows touches. Without this a tap aimed at the dimmed
               picture lands on the live page underneath, which is a page the
               parent cannot see and may not be the one in the picture. */
            isClickable = true
            contentDescription = getString(R.string.splash_loading)
            addView(splashShot, FrameLayout.LayoutParams(-1, -1))
            addView(column, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        }
    }

    /* Faded rather than switched off. The page arriving underneath is a
       different picture in the same colours, and a hard cut between them reads
       as a flicker; a short cross fade reads as the page resolving. Short
       enough that nobody waits on it. */
    private fun hideSplash() {
        if (splash.visibility != View.VISIBLE) return
        splash.animate().alpha(0f).setDuration(160).withEndAction {
            splash.visibility = View.GONE
            splash.alpha = 1f
            // The snapshot is the largest thing this app holds in memory and
            // it has no further use once the live page is up.
            splashShot.setImageDrawable(null)
        }.start()
    }

    /* Built in code rather than as a layout file, because it is nine views and
       a layout XML for it would be a second file to find. */
    private fun buildOfflineView(): View {
        val pad = (24 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(pageColor())
            gravity = Gravity.CENTER
            offlineTitle = TextView(context).apply {
                text = getString(R.string.offline_title)
                textSize = 22f
                setTextColor(getColor(R.color.page_text))
            }
            addView(offlineTitle)
            offlineBody = TextView(context).apply {
                text = getString(R.string.offline_body)
                textSize = 15f
                setTextColor(getColor(R.color.page_muted))
                setPadding(0, pad / 2, 0, pad)
            }
            addView(offlineBody)
            addView(Button(context).apply {
                text = getString(R.string.retry)
                minimumHeight = (48 * resources.displayMetrics.density).toInt()
                setOnClickListener { retry() }
            })
            offlineHint = TextView(context).apply {
                text = getString(R.string.waiting_for_network)
                textSize = 13f
                setTextColor(getColor(R.color.page_muted))
                setPadding(0, pad / 2, 0, 0)
                visibility = View.GONE
            }
            addView(offlineHint)
        }
    }

    private fun pageColor(): Int = getColor(R.color.page_bg)

    /* Back goes back through the site, and only leaves the app when there is
       nowhere left to go. Without this, back from the fee screen closes the app
       outright, which is the commonest complaint about any wrapper.

       Android 13 has its own dispatcher for the gesture and the platform one
       is what a no-AndroidX app registers with; older phones still call the
       deprecated override. Both routes land on the same line. */
    private fun back() {
        if (web.canGoBack()) web.goBack() else finish()
    }

    private fun registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { back() }
        }
    }

    @Deprecated("Kept for phones before Android 13; see registerBack.")
    @SuppressLint("GestureBackNavigation")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) super.onBackPressed() else back()
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        if (!Shell.appLockEnabled()) return
        // A cold start is "away for ever"; a switch to another app and back
        // inside a minute is not away at all.
        val away = if (leftAt == 0L) Long.MAX_VALUE else SystemClock.elapsedRealtime() - leftAt
        if (away >= LOCK_AFTER_MS) showLock()
    }

    override fun onStop() {
        super.onStop()
        foreground = false
        leftAt = SystemClock.elapsedRealtime()
        /* Only when there is something worth keeping.

           Drawing the WebView into a bitmap is main-thread work on the way out
           of the app, which is the one moment a cheap phone is already busy
           tearing down a window. Skipping it when the page is not visible --
           the error panel is up, or the view never painted -- costs nothing
           and removes the case where the snapshot is a picture of an error
           panel, which is the last thing worth showing on the next start. */
        if (web.visibility == View.VISIBLE && web.width > 0 && web.height > 0) {
            keepLastScreen()
        }
    }

    /* Kept from onStop rather than onPause, because onPause also fires for the
       file picker and the biometric prompt, and drawing the WebView underneath
       one of those would file a picture of a dialog as the last screen.
       Nothing is kept while the app lock is on, and nothing is kept from a
       screen that never painted or is showing an error. */
    private fun keepLastScreen() {
        if (Shell.appLockEnabled()) return
        if (!painted || offline.visibility == View.VISIBLE) return
        if (splash.visibility == View.VISIBLE) return
        LastScreen.save(web, filesDir)
    }

    /* Decoding is a few milliseconds and this runs during the launch, which is
       the one stretch of time this whole change is about, so it happens off
       the main thread and drops in when it arrives. Arriving after the page
       has already painted is fine and common on wifi: the splash is gone by
       then and the picture is never shown at all. */
    private fun restoreLastScreen() {
        if (Shell.appLockEnabled()) {
            LastScreen.clear(filesDir)
            return
        }
        val dir = filesDir
        Thread {
            val shot = LastScreen.load(dir) ?: return@Thread
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (splash.visibility != View.VISIBLE) return@runOnUiThread
                splashShot.setImageBitmap(shot)
                splashShot.visibility = View.VISIBLE
            }
        }.start()
    }

    private fun canLock(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bm = getSystemService(BiometricManager::class.java) ?: return false
            return bm.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            ) == BiometricManager.BIOMETRIC_SUCCESS
        }
        return (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isDeviceSecure
    }

    private fun showLock() {
        lock.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
        askToUnlock()
    }

    private fun unlocked() {
        prompting = false
        lock.visibility = View.GONE
        web.visibility = View.VISIBLE
    }

    private fun askToUnlock() {
        if (prompting) return
        prompting = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val prompt = BiometricPrompt.Builder(this)
                .setTitle(getString(R.string.lock_title))
                .setDescription(getString(R.string.lock_body))
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                )
                .build()
            prompt.authenticate(
                CancellationSignal(),
                mainExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) {
                        unlocked()
                    }

                    // Cancelled, too many tries, or the sensor is busy: the
                    // panel stays and its button asks again.
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                        prompting = false
                    }
                },
            )
            return
        }
        val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        val intent = km.createConfirmDeviceCredentialIntent(
            getString(R.string.lock_title),
            getString(R.string.lock_body),
        )
        if (intent == null) {
            // No secure lock on the phone: there is nothing to ask for.
            unlocked()
            return
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_UNLOCK)
    }

    private fun buildLockView(): View {
        val pad = (24 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(pageColor())
            gravity = Gravity.CENTER
            isClickable = true
            addView(TextView(context).apply {
                text = getString(R.string.lock_title)
                textSize = 22f
                setTextColor(getColor(R.color.page_text))
            })
            addView(TextView(context).apply {
                text = getString(R.string.lock_body)
                textSize = 15f
                setTextColor(getColor(R.color.page_muted))
                setPadding(0, pad / 2, 0, pad)
            })
            addView(Button(context).apply {
                text = getString(R.string.unlock)
                minimumHeight = (48 * resources.displayMetrics.density).toInt()
                setOnClickListener { askToUnlock() }
            })
        }
    }

    override fun onPause() {
        super.onPause()
        // The session cookie is written to disk lazily. A phone that kills
        // the app before that happens signs the parent out.
        CookieManager.getInstance().flush()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // So a rotation does not throw away the screen the parent was reading.
        web.saveState(outState)
    }

    override fun onDestroy() {
        netCallback?.let { cb ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
        }
        netCallback = null
        downloadWatcher?.let { runCatching { unregisterReceiver(it) } }
        downloadWatcher = null
        /* Last chance. If the activity is going away with a chooser still
           unanswered, the callback is about to be leaked along with the page
           that is waiting on it. */
        deliverFiles(null)
        pull.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        val PORTAL_HOST: String? = Uri.parse(BuildConfig.PORTAL_URL).host
        const val REQUEST_FILES = 1001
        const val REQUEST_UNLOCK = 1002
        const val REQUEST_STORAGE = 1003

        /* RFC 6266: `filename*=UTF-8''name%20here` for anything not plain
           ASCII, `filename="name"` or a bare token otherwise. All three are
           seen in the wild from the same server depending on the name, and a
           circular titled in Telugu arrives as the first. */
        val EXTENDED = Regex("""filename\*\s*=\s*[^']*'[^']*'([^;\s]+)""", RegexOption.IGNORE_CASE)
        // Not a raw string: a Kotlin raw string cannot end in a quote.
        val QUOTED = Regex("filename\\s*=\\s*\"([^\"]*)\"", RegexOption.IGNORE_CASE)
        val PLAIN = Regex("""filename\s*=\s*([^;\s"]+)""", RegexOption.IGNORE_CASE)
        const val LOCK_AFTER_MS = 60_000L

        /* Long enough to read one line while glancing at a bus map, short
           enough that it is not still covering the site's header when the
           parent goes to tap it. */
        const val BANNER_MS = 4000L
    }
}
