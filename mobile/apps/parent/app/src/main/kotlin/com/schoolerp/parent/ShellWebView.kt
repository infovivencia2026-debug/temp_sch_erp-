package com.schoolerp.parent

import android.annotation.SuppressLint
import android.content.Context
import android.view.ActionMode
import android.view.View
import android.webkit.WebView
import kotlin.math.roundToInt

/* A WEBVIEW WITH THE BROWSER TAKEN OUT OF IT.

   A bare WebView is a browser's rendering surface with a browser's habits
   still attached: it draws a scrollbar down the right edge, it stretches and
   glows at the ends, it raises Copy / Share / Web search when a finger rests
   on anything, and it scales its text by the phone's font setting with no
   upper bound. Each of those is a small announcement that this is a web page,
   and together they are what a parent means by "it feels like a website".
   This subclass switches them off at the view, where they cannot be switched
   back on by a page or a setting.

   LONG PRESS DOES NOTHING, ANYWHERE THAT IS NOT A FIELD.

   The previous version (suppressPointlessSelection in MainActivity) refused
   the long press on images and links and allowed it on plain text, on the
   argument that a parent copies a receipt number out of the page. The user
   of this app has now said, in so many words, that they do not want the
   copy handles at all: a hold on a fee row, a circular, a name, a heading
   raised the selection bar with Copy, Share and Web search on it, and that
   bar is the browser showing through. So the long press is consumed
   outright, everywhere except inside an editable field, where the handles
   are the only way to fix a mis-typed phone number and the Paste bubble is
   the only way to paste one.

   Three routes can raise that bar, and all three are closed:

     1. The long press itself. Before the renderer is told about a long press
        Chromium offers it to the embedder by calling performLongClick() on
        this view; if that returns true the gesture is dropped and no
        selection is ever made. Overriding performLongClick, rather than
        setting a listener, also means no LONG_PRESS haptic: a buzz answering
        a hold that then does nothing is its own small wrongness.
     2. A double tap on a word, which Chromium selects without a long press.
        The selection then asks the view for an action mode through
        startActionMode; returning null here refuses it, and Chromium clears
        the selection it could not put a menu on.
     3. A keyboard's select-all or a page's own selection call, which arrive
        at the same startActionMode and get the same answer.

   "Inside an editable field" is judged from the hit test result, which
   Chromium refreshes on every touch down and which reports EDIT_TEXT_TYPE
   for an input or textarea. A contenteditable region is reported the same
   way. Nothing in the portal selects text programmatically, so the plain
   text case never needs a menu. */
@SuppressLint("SetJavaScriptEnabled")
class ShellWebView(context: Context) : WebView(context) {

    init {
        /* A scrollbar down the edge is the single cheapest browser tell, and
           the page scrolls an element inside the document anyway, so the
           WebView's own bar only ever appeared for a moment during a load. */
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        /* No stretch at the ends. PullToRefresh draws the one indicator the
           top edge wants; the platform's on top of it was two answers to one
           gesture, and the bottom one is a browser reaching the end of a
           page rather than an app reaching the end of a list. */
        overScrollMode = View.OVER_SCROLL_NEVER
        applyTextScale()
    }

    private fun editing(): Boolean = hitTestResult.type == HitTestResult.EDIT_TEXT_TYPE

    override fun performLongClick(): Boolean {
        if (editing()) return super.performLongClick()
        return true
    }

    override fun performLongClick(x: Float, y: Float): Boolean {
        if (editing()) return super.performLongClick(x, y)
        return true
    }

    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? {
        if (editing()) return super.startActionMode(callback)
        return null
    }

    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? {
        if (editing()) return super.startActionMode(callback, type)
        return null
    }

    /* TEXT SIZE FOLLOWS THE PHONE, WITHIN REASON.

       A WebView multiplies its text by the phone's font scale on its own,
       which is right in direction and wrong in degree. The portal's layout is
       built for a phone's text at up to about a third larger than standard;
       "Largest" on a recent Android is twice standard, and at that size the
       dock's labels wrap under their icons, fee rows break into two lines and
       the header's buttons stack. The page was designed to be reflowed by its
       own App text size setting, which the parent still has and which the
       clamp leaves room for.

       So the scale is honoured from "Small" to somewhat past "Large" and held
       there. A parent who needs more than that is better served by the page's
       own slider than by a layout that has stopped fitting. Re-applied only
       on creation: a font scale change restarts the activity, so a new view
       reads the new value. */
    private fun applyTextScale() {
        val scale = resources.configuration.fontScale
        settings.textZoom = (scale * 100).roundToInt().coerceIn(85, 130)
    }
}
