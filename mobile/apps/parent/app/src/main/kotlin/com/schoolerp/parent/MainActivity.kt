package com.schoolerp.parent

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
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
    private lateinit var offlineBody: TextView
    private lateinit var progress: ProgressBar

    /* The page is waiting on this. Every path out of the chooser has to call
       it exactly once, including every failure and the plain cancel, or the
       input element stays disabled for the life of the page and the parent
       cannot even try again. */
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var pendingCapture: Uri? = null

    /* False until the web content has actually painted something. The system
       splash is held up against it; see holdSplash. */
    private var painted = false

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
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        pull = PullToRefresh(this).apply {
            canScrollUp = { web.canScrollVertically(-1) }
            onRefresh = { web.reload() }
        }
        web = buildWebView()
        pull.addView(web, FrameLayout.LayoutParams(-1, -1))
        root.addView(pull, FrameLayout.LayoutParams(-1, -1))
        root.addView(offline, FrameLayout.LayoutParams(-1, -1))
        root.addView(
            progress,
            FrameLayout.LayoutParams(-1, (4 * resources.displayMetrics.density).toInt(), Gravity.TOP),
        )
        setContentView(root)
        registerBack()
        holdSplash()

        /* restoreState hands back null when the saved bundle is unusable,
           which it is after the process was killed for long enough. Treating
           that as restored left a blank rectangle with no way out. */
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            load(deepLink(intent) ?: BuildConfig.PORTAL_URL)
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
       is capped: after four seconds the shell gives up and shows whatever it
       has, which will be the offline panel if the load failed. Better a
       truthful error than a splash forever. */
    private fun holdSplash() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val giveUpAt = System.currentTimeMillis() + 4000
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
        root.postDelayed({ painted = true; root.invalidate() }, 4100)
    }

    @SuppressLint("SetJavaScriptEnabled")
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
        }
        view.setBackgroundColor(pageColor())

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
                // Only the page itself. A tile that failed to load is not a
                // reason to replace a working screen with an error.
                if (request.isForMainFrame) showOffline(R.string.offline_body)
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
                    showOffline(R.string.server_body)
                }
            }

            /* Pixels on screen, which is a different and much earlier moment
               than onPageFinished: a React app finishes loading long after it
               has painted something worth looking at. Revealing here rather
               than at onPageFinished is what keeps the splash from handing
               over to an empty frame. */
            override fun onPageCommitVisible(view: WebView, url: String?) {
                painted = true
                if (offline.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                painted = true
                progress.visibility = View.GONE
                pull.stopRefreshing()
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

        /* Receipts, circulars and homework attachments come down as
           attachments, and a WebView does nothing at all with an attachment:
           the tap lands and nothing happens. Hand the URL to the download
           manager with the session cookie, since the file is behind the login,
           and let the phone's own notification open it. */
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val uri = Uri.parse(url)
            if (uri.host != PORTAL_HOST) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                return@setDownloadListener
            }
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(uri).apply {
                setMimeType(mimeType)
                addRequestHeader("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                setTitle(name)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalFilesDir(this@MainActivity, Environment.DIRECTORY_DOWNLOADS, name)
            }
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val ok = runCatching { dm.enqueue(request) }.isSuccess
            Toast.makeText(
                this,
                getString(if (ok) R.string.download_started else R.string.download_failed, name),
                Toast.LENGTH_SHORT,
            ).show()
        }
        return view
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
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl(url)
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
        web.loadUrl(url)
    }

    /* Retry goes back to the page that failed, not to the front door. A
       parent who lost signal on the fee screen wants the fee screen. */
    private fun retry() {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        pull.pullEnabled = true
        if (web.url != null) web.reload() else load(BuildConfig.PORTAL_URL)
    }

    private fun showOffline(body: Int) {
        progress.visibility = View.GONE
        // Whatever was holding the splash, this is the thing worth showing.
        painted = true
        /* A pull that started this load has to be released here as well as on
           success, or a parent who pulls to refresh in a tunnel is left with a
           spinner that never stops on top of an error that explains itself. */
        pull.stopRefreshing()
        // The panel has its own retry button; a second, invisible way to do
        // the same thing behind it is not an improvement.
        pull.pullEnabled = false
        offlineBody.text = getString(body)
        web.visibility = View.GONE
        offline.visibility = View.VISIBLE
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
            addView(TextView(context).apply {
                text = getString(R.string.offline_title)
                textSize = 22f
                setTextColor(getColor(R.color.page_text))
            })
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
    }
}
