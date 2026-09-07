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

/* THE PAGE'S OWN GESTURES, WHICH THE SHELL MUST NOT TAKE.

   Everything above switches a browser habit off. This is the other
   direction. The board can be customised on the phone (web/src/features/
   bento/WidgetLayer.tsx): a half-second hold on a card enters the mode, a
   fifth-of-a-second hold then lifts a card and carries it, a swipe still
   turns the page, and the page refuses its own scroll under a carried card
   with a non-passive touchmove. Every one of those arrives as touches the
   WebView must pass through untouched, and the one thing in this shell that
   takes touches away from the WebView is PullToRefresh. It reads the page's
   scroller position, and the board sits at the top of its scroller, so a
   card carried downward from the top row was a pull: an ACTION_CANCEL to
   the page and the card dropped where it was.

   The page says when it is in the mode — `data-arranging` on `.bento-board`,
   `data-dragging` while a card is carried — but it says so to the DOM, not
   to the shell. The script below is the same shape as SystemBars.WATCH:
   injected after every load, idempotent per document, it watches those two
   attributes and reports the answer through the bridge (setGestureLock),
   where PullToRefresh reads it. A bundle that has never heard of the mode
   has no such board and reports false once. Attribute mutations for the two
   names anywhere in the tree, and childList for the board unmounting while
   the mode is on: a route change removes the node before React clears the
   attribute on it, and a lock left set would refuse the pull until the next
   load.

   THE STYLE IS THE ANDROID HALF OF THE iOS BRIDGE SCRIPT (parent-ios/
   ParentApp/Shell/BridgeScript.swift), for a bundle that predates the site's
   own copy of these rules. Selection is already refused at the view
   (performLongClick, startActionMode); the rule makes the refusal airtight
   and gives fields their handles back. touch-action pan-x pan-y on the body
   only ever removes zoom, which setSupportZoom(false) has removed already;
   it cannot loosen the board's own `pan-x` on a card, because touch-action
   along the ancestor chain intersects and never adds. -webkit-touch-callout
   is WebKit-only and does nothing here; kept so the two scripts read the
   same. Injected after first paint, so none of it can flash: nothing in it
   changes a pixel. */
internal object PageGestures {

    const val WATCH = """
(function () {
  var s = window.ErpShell;
  if (!s || typeof s.setGestureLock !== 'function') return;
  if (window.__erpGestures) return;
  window.__erpGestures = true;
  if (!document.getElementById('erp-shell-style')) {
    var style = document.createElement('style');
    style.id = 'erp-shell-style';
    style.textContent =
      'img, a { -webkit-touch-callout: none; }\n' +
      'html, body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }\n' +
      'body { -webkit-user-select: none; user-select: none; touch-action: pan-x pan-y; }\n' +
      'input, textarea, [contenteditable], [data-selectable] { -webkit-user-select: text; user-select: text; }';
    (document.head || document.documentElement).appendChild(style);
  }
  var last = null;
  function report() {
    var held = !!document.querySelector('.bento-board[data-arranging], .bento-board[data-dragging]');
    if (held === last) return;
    last = held;
    try { s.setGestureLock(held); } catch (e) {}
  }
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-arranging', 'data-dragging'],
    childList: true,
    subtree: true
  });
  report();
})();
"""

    fun watch(web: WebView) {
        web.evaluateJavascript(WATCH, null)
    }
}
