package com.schoolerp.parent

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.app.Activity
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

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
*/
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var offline: View

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        web = WebView(this)
        offline = buildOfflineView()
        offline.visibility = View.GONE
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        root.addView(offline, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        with(web.settings) {
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
        web.setBackgroundColor(Color.parseColor("#0b0c0e"))

        web.webViewClient = object : WebViewClient() {
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
                error: android.webkit.WebResourceError,
            ) {
                // Only the page itself. A tile that failed to load is not a
                // reason to replace a working screen with an error.
                if (request.isForMainFrame) showOffline()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (offline.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            }
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else load()
    }

    private fun load() {
        offline.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl(BuildConfig.PORTAL_URL)
    }

    private fun showOffline() {
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
            setBackgroundColor(Color.parseColor("#0b0c0e"))
            gravity = android.view.Gravity.CENTER
            addView(TextView(context).apply {
                text = getString(R.string.offline_title)
                textSize = 22f
                setTextColor(Color.WHITE)
            })
            addView(TextView(context).apply {
                text = getString(R.string.offline_body)
                textSize = 15f
                setTextColor(Color.parseColor("#9aa0a6"))
                setPadding(0, pad / 2, 0, pad)
            })
            addView(Button(context).apply {
                text = getString(R.string.retry)
                setOnClickListener { load() }
            })
        }
    }

    /* Back goes back through the site, and only leaves the app when there is
       nowhere left to go. Without this, back from the fee screen closes the app
       outright, which is the commonest complaint about any wrapper.

       Deprecated on Activity in favour of the dispatcher AndroidX provides,
       and this app deliberately has no AndroidX. The override still runs. */
    @Deprecated("Platform Activity has no back dispatcher; this is the hook it does have.")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // So a rotation does not throw away the screen the parent was reading.
        web.saveState(outState)
    }

    private companion object {
        val PORTAL_HOST: String? = Uri.parse(BuildConfig.PORTAL_URL).host
    }
}
