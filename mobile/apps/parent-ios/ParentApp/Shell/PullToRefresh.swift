import UIKit

/* PULL DOWN TO RELOAD, BECAUSE A PAGE THAT CANNOT BE PULLED READS AS A PAGE.

   The obvious implementation is UIRefreshControl on the web view's scroll
   view. It is not used, for the reason the Android PullToRefresh records
   about SwipeRefreshLayout: the thing being wrapped is a whole web
   application that scrolls an element INSIDE the document, so the scroll view
   sits at zero on nearly every screen however far down the parent actually
   is, and a refresh control on it fires fifteen screens into the setup
   wizard. On a half-filled form that loses the form.

   The page tells the shell where its own scroller is (setAtTop, through the
   bridge) and this gesture believes the page. The rules are deliberately
   mean, and every one exists to refuse rather than to trigger:

     - it only considers a gesture that began with the page reporting itself
       at the top, read once when the pan begins and not again;
     - it only considers a drag that is mostly vertical;
     - it requires a full slop of downward travel before it takes the gesture;
     - it gives up the instant the finger goes back above where it started.

   The recogniser runs alongside the web view's own, never instead of it, so
   the page still scrolls and bounces underneath and ordinary use is not
   affected at all. */
final class PullToRefresh: NSObject, UIGestureRecognizerDelegate {

    /* Set by the shell. Returns true while the page reports its scroller is
       away from the top, in which case no gesture is ever taken. */
    var canScrollUp: () -> Bool = { true }

    /* Called once per accepted pull. The shell reloads; it must call
       stopRefreshing when the load finishes, or the spinner sits there for
       ever and the app looks hung. */
    var onRefresh: () -> Void = {}

    /* The spinner's travel and opacity, for the SwiftUI layer to draw. */
    var onChange: (_ travel: CGFloat, _ alpha: CGFloat, _ visible: Bool) -> Void = { _, _, _ in }

    /* Turned off while an error panel is showing. The panel has its own retry
       button, and a pull that silently did the same thing behind it is two
       competing ways to do one act, one of them invisible. */
    var pullEnabled = true

    private(set) var refreshing = false

    let recognizer = UIPanGestureRecognizer()

    private let slop: CGFloat = 10
    private let trigger: CGFloat = 72
    private let ceiling: CGFloat = 132

    private var eligible = false
    private var dragging = false
    private var travel: CGFloat = 0

    override init() {
        super.init()
        recognizer.addTarget(self, action: #selector(pan(_:)))
        recognizer.maximumNumberOfTouches = 1
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = self
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }

    @objc private func pan(_ g: UIPanGestureRecognizer) {
        switch g.state {
        case .began:
            dragging = false
            travel = 0
            // The one and only reading of the page's position.
            eligible = pullEnabled && !refreshing && !canScrollUp()
            // A pan begins only after the finger has already moved, so the
            // first translation is worth judging rather than discarding.
            moved(g)
        case .changed:
            moved(g)
        case .ended:
            if dragging { release(travel >= trigger * 0.5) }
            eligible = false
        case .cancelled, .failed:
            release(false)
        default:
            break
        }
    }

    private func moved(_ g: UIPanGestureRecognizer) {
        guard eligible else { return }
        let t = g.translation(in: g.view)
        if !dragging {
            if t.y > slop && t.y > abs(t.x) {
                dragging = true
            } else if t.y < -slop || abs(t.x) > slop {
                // Any upward or sideways travel past slop settles the question
                // for the rest of this gesture: it was not a pull.
                eligible = false
                return
            } else {
                return
            }
        }
        let dy = t.y - slop
        if dy <= 0 {
            // Back above the start. Abandon rather than clamp at zero, so the
            // parent gets their scrolling back mid gesture.
            release(false)
            return
        }
        // Damped, so the spinner slows as it is pulled and the travel has a
        // floor. An undamped follow makes a short flick look like a pull.
        travel = min(dy * 0.5, ceiling)
        onChange(travel, min(1, dy / trigger), true)
    }

    private func release(_ commit: Bool) {
        dragging = false
        eligible = false
        if !commit {
            onChange(0, 0, false)
            return
        }
        refreshing = true
        onChange(64, 1, true)
        onRefresh()
    }

    /* Called by the shell when the load it started has finished, failed, or
       been replaced. Idempotent on purpose: a page that fires both an error
       and a finish would otherwise animate twice. */
    func stopRefreshing() {
        if !refreshing { return }
        refreshing = false
        onChange(0, 0, false)
    }
}
