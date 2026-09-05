import Foundation

/* THE ONE HOLE IN THE WALL BETWEEN THE PAGE AND THE PHONE.

   The site talks to the Android shell through window.ErpShell, five methods
   and nothing else (web/src/lib/shell-scroll.ts is the contract). Android
   gets that object for free from addJavascriptInterface, and its methods are
   synchronous: appLockEnabled() returns a boolean the page reads on the spot.

   WKWebView has no synchronous bridge. A script message handler is one-way
   and asynchronous, so the same object is built here in JavaScript, injected
   before any page script runs, and answers the two questions the page asks
   from state it was handed at injection: whether the lock is on and whether
   the phone can do it. The three commands post a message and return. The page
   cannot tell the difference, which is the point: one bundle, two shells.

   Everything the page can do through this is still nothing but booleans and
   a haptic kind. It cannot read, cannot navigate, cannot open anything.
   Foreign hosts never see it because WebShell sends them to Safari, so the
   only code that can reach the handler is the school's own bundle, and the
   handler checks the origin again anyway.

   The style rule at the end is the iOS half of Android's
   suppressPointlessSelection: a long press on an image or a link in a
   WKWebView raises the system callout (Open, Copy, Share), and on the bus
   screen holding a finger on the map is how a person drags it. Text and
   fields are left alone so a receipt number can still be copied out. */
enum BridgeScript {
    static let handlerName = "erpShell"

    static func source(appLock: Bool, canLock: Bool) -> String {
        """
        (function () {
          if (window.ErpShell) return;
          var state = { appLock: \(appLock ? "true" : "false"), canLock: \(canLock ? "true" : "false") };
          function post(kind, value) {
            try { window.webkit.messageHandlers.\(handlerName).postMessage({ kind: kind, value: value }); } catch (e) {}
          }
          window.ErpShell = {
            setAtTop: function (v) { post('atTop', !!v); },
            setAppLock: function (on) { state.appLock = !!on; post('appLock', !!on); },
            appLockEnabled: function () { return state.appLock; },
            biometricsAvailable: function () { return state.canLock; },
            haptic: function (kind) { post('haptic', String(kind)); }
          };
          var style = document.createElement('style');
          /* The second rule is the iOS focus-zoom: WebKit zooms the whole page
             in when a focused field's text is under 16px, and does not zoom
             back out on blur, so one tap on the sign-in form leaves every
             screen after it cropped at the right edge. The site carries the
             same rule; this copy is for a bundle that predates it. */
          style.textContent = 'img, a { -webkit-touch-callout: none; }\\n' +
            'input, select, textarea { font-size: max(16px, 1em); }';
          (document.head || document.documentElement).appendChild(style);
        })();
        """
    }
}
