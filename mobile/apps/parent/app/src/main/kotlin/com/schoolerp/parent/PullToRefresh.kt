package com.schoolerp.parent

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ProgressBar

/* PULL DOWN TO RELOAD, BECAUSE A PAGE THAT CANNOT BE PULLED READS AS A PAGE.

   The gesture is close to the only thing every Android user tests without
   meaning to. A screen that does not answer it is a screen they conclude is
   stale, and the usual next move is to close the app and open it again, which
   in a shell like this one costs a full cold start and a re round trip for
   everything. Answering the pull is cheaper than the workaround it prevents.

   The obvious implementation is androidx SwipeRefreshLayout. It is not used
   here for the reason given in app/build.gradle.kts: this app has no
   dependencies, and a single gesture is not worth starting a version train
   the tracker app would then have to be kept in step with. This is that one
   gesture and nothing else, at roughly a tenth of the size.

   THE HARD PART IS NOT THE ANIMATION, IT IS KNOWING WHEN TO KEEP OUT OF THE
   WAY. The thing being wrapped is a whole web application, and the failure
   mode of a naive version is that it steals downward drags from the page: a
   parent scrolling a fee ledger back up to the top finds the app reloading
   under them and losing their place, which is much worse than having no
   gesture at all. So the rules here are deliberately mean, and every one of
   them exists to refuse rather than to trigger:

     - It only ever considers a gesture that began with the content already at
       the very top. canScrollUp is asked once, at ACTION_DOWN, and not again,
       because asking mid gesture is how a fling that lands at zero turns into
       a refresh nobody asked for.
     - It only considers a drag that is mostly vertical. A horizontal swipe on
       a carousel or a table that scrolls sideways is not a pull, and comparing
       the two deltas is the cheapest way to say so.
     - It requires the finger to travel a full touch slop downward before it
       takes the gesture, so a tap that wobbles is still a tap.
     - It gives up the instant the finger goes back above where it started.
       A parent who begins a pull and changes their mind gets their scroll
       back rather than a rubber band that will not let go.

   What it deliberately cannot do is see inside the page. If the site puts its
   own scrolling container inside the viewport, the WebView itself is at scroll
   zero the whole time and this will offer to refresh while the parent is
   scrolling that inner list. There is no native side answer to that; the fix
   if it ever bites is for the page to let the document scroll rather than a
   div. It is written down here so the next person does not have to rediscover
   it from a bug report.
*/
class PullToRefresh(context: Context) : FrameLayout(context) {

    /* Set by the activity. Returns true while the wrapped content is scrolled
       away from its top, in which case this layout never takes a gesture. */
    var canScrollUp: () -> Boolean = { false }

    /* Called once per accepted pull. The activity reloads; it must call
       stopRefreshing when the load finishes, or the spinner sits there
       forever and the app looks hung. */
    var onRefresh: () -> Unit = {}

    /* Turned off while an error panel is showing. The panel has its own
       explicit retry button, and a pull that silently did the same thing
       behind it left two competing ways to do one act, one of them invisible.

       Named pullEnabled rather than the obvious "enabled": View already has a
       setEnabled, and a Kotlin property of that name silently becomes an
       accidental override of it, which would have meant switching the gesture
       off also switching off touch handling for the WebView underneath. The
       compiler caught it; the name is kept distinct so nobody reintroduces
       it. */
    var pullEnabled = true

    private val spinner = ProgressBar(context).apply {
        isIndeterminate = true
        visibility = View.INVISIBLE
    }
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val density = context.resources.displayMetrics.density
    private val trigger = 72f * density
    private val ceiling = 132f * density
    private val resting = -40f * density

    private var startX = 0f
    private var startY = 0f
    private var eligible = false
    private var dragging = false
    private var refreshing = false

    init {
        val size = (28 * density).toInt()
        addView(
            spinner,
            LayoutParams(size, size, android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL)
                .apply { topMargin = (16 * density).toInt() },
        )
        spinner.translationY = resting
    }

    /* Intercept rather than handle. While this returns false every touch goes
       straight through to the WebView untouched, which is the state it is in
       for all but a deliberate pull, and is why ordinary scrolling is not
       affected at all. */
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (!pullEnabled || refreshing) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.x
                startY = event.y
                dragging = false
                // The one and only reading of scroll position, taken before a
                // finger has moved anything.
                eligible = !canScrollUp()
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                // A second finger means a pinch zoom on a document, never a
                // pull. Hand the whole gesture back.
                eligible = false
                dragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!eligible) return false
                val dy = event.y - startY
                val dx = event.x - startX
                if (dy > slop && dy > Math.abs(dx)) {
                    dragging = true
                    return true
                }
                // Any upward or sideways travel past slop settles the question
                // for the rest of this gesture: it was not a pull.
                if (dy < -slop || Math.abs(dx) > slop) eligible = false
            }
        }
        return false
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!dragging) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val dy = event.y - startY - slop
                if (dy <= 0f) {
                    // Back above the start. Abandon rather than clamp at zero,
                    // so the parent gets their scrolling back mid gesture.
                    release(false)
                    return false
                }
                // Damped, so the spinner slows as it is pulled and the travel
                // has a floor. An undamped follow makes a short flick look
                // like a committed pull.
                spinner.translationY = resting + Math.min(dy * 0.5f, ceiling)
                spinner.visibility = View.VISIBLE
                spinner.alpha = Math.min(1f, dy / trigger)
                return true
            }
            MotionEvent.ACTION_UP -> {
                release(spinner.translationY - resting >= trigger * 0.5f)
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                release(false)
                return true
            }
        }
        return true
    }

    private fun release(commit: Boolean) {
        dragging = false
        eligible = false
        if (!commit) {
            retract()
            return
        }
        refreshing = true
        spinner.animate().translationY(24f * density).alpha(1f).setDuration(150).start()
        onRefresh()
    }

    /* Called by the activity when the load it started has finished, failed, or
       been replaced. Idempotent on purpose: a page that fires both an error
       and a finish would otherwise animate twice. */
    fun stopRefreshing() {
        if (!refreshing) return
        refreshing = false
        retract()
    }

    private fun retract() {
        spinner.animate()
            .translationY(resting)
            .alpha(0f)
            .setInterpolator(DecelerateInterpolator())
            .setDuration(200)
            .withEndAction { spinner.visibility = View.INVISIBLE }
            .start()
    }
}
