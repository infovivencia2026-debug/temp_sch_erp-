package com.schoolerp.parent

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.window.OnBackInvokedDispatcher
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
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
*/
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var offline: View
    private lateinit var offlineBody: TextView
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this).apply {
            /* targetSdk 35+ draws edge to edge whether asked or not. Without
               this the site's header sits under the clock and the bottom dock
               under the gesture bar, and the keyboard covers the field being
               typed into. The site's own safe-area CSS reads zero in a
               WebView, so the padding has to come from here. */
            fitsSystemWindows = true
            setBackgroundColor(pageColor())
        }
        offline = buildOfflineView()
        offline.visibility = View.GONE
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        web = buildWebView()
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        root.addView(offline, FrameLayout.LayoutParams(-1, -1))
        root.addView(
            progress,
            FrameLayout.LayoutParams(-1, (4 * resources.displayMetrics.density).toInt(), Gravity.TOP),
        )
        setContentView(root)
        registerBack()

        /* restoreState hands back null when the saved bundle is unusable,
           which it is after the process was killed for long enough. Treating
           that as restored left a blank rectangle with no way out. */
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) load()
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

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
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
                root.removeView(view)
                view.destroy()
                web = buildWebView()
                root.addView(web, 0, FrameLayout.LayoutParams(-1, -1))
                if (url != null) web.loadUrl(url) else load()
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.GONE
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

    private fun load() {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl(BuildConfig.PORTAL_URL)
    }

    /* Retry goes back to the page that failed, not to the front door. A
       parent who lost signal on the fee screen wants the fee screen. */
    private fun retry() {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        if (web.url != null) web.reload() else load()
    }

    private fun showOffline(body: Int) {
        progress.visibility = View.GONE
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
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        val PORTAL_HOST: String? = Uri.parse(BuildConfig.PORTAL_URL).host
    }
}
