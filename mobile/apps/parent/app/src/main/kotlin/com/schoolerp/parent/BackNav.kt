package com.schoolerp.parent

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Build
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/* BACK IS ONLY CLAIMED WHILE THERE IS SOMEWHERE TO GO BACK TO.

   The activity used to register its back callback once, at creation, and
   keep it for the life of the window. That is correct for the gesture's
   result and wrong for its feel. From Android 14 the system animates back
   before the gesture completes, and it can only do that when it knows what
   back will do: an app with a callback registered has said "I will decide",
   so the system shows nothing while the finger drags, and when the app then
   calls finish() the window simply vanishes. A parent on the home screen of
   the portal dragging back got no preview of the launcher and then an
   abrupt exit, which is the one place a native app and a wrapper are most
   visibly different.

   So the callback is registered while the WebView has history and removed
   when it does not. With history, back walks the page's history and the
   system stays out of it, which is right: there is no native preview that
   could show the previous route of a page. Without history, the system's
   own default runs, the launcher peeks in under the drag exactly as it does
   for every other app, and letting go leaves.

   Kept in step from doUpdateVisitedHistory, which the WebView calls for
   every entry added or replaced, including the pushState navigations the
   portal's router makes. Nothing to do before Android 13: those phones
   still call onBackPressed, which MainActivity handles. */
internal class BackNav(private val activity: Activity, private val onBack: () -> Unit) {

    private var registered = false
    private var callback: OnBackInvokedCallback? = null

    @SuppressLint("NewApi")
    fun sync(canGoBack: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (canGoBack == registered) return
        val dispatcher = activity.onBackInvokedDispatcher
        if (canGoBack) {
            val cb = callback ?: OnBackInvokedCallback { onBack() }.also { callback = it }
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
        } else {
            callback?.let { dispatcher.unregisterOnBackInvokedCallback(it) }
        }
        registered = canGoBack
    }
}
