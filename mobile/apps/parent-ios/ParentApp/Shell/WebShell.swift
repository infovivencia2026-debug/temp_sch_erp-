import Combine
import UIKit
import WebKit

/* A SHELL AROUND THE SCHOOL'S OWN SITE, AND NOTHING MORE.

   No login of its own, no copy of any screen, no cached state to fall out of
   step with the server. Everything a parent sees here is the page the browser
   would have shown, which is the whole point: a fix shipped this afternoon
   reaches every installed app without anybody updating anything, and there
   is no second implementation of the fee screen to keep in step with the
   first. This is the iOS sibling of mobile/apps/parent's MainActivity, and
   where a decision here looks odd the reason is usually written down there.

   What a shell still has to do itself, because the site cannot: show that a
   page is loading, say which of three different things went wrong, hand a
   downloaded receipt to the phone, survive its own renderer dying, keep a
   foreign page out, and ask for a face when the parent has asked for that.
   Each is here because leaving it out is a complaint.

   This object owns the web view and is every delegate it has. The SwiftUI
   views read its published state and draw the chrome — splash, panel,
   banner, lock, spinner — around the page. */
final class WebShell: NSObject, ObservableObject {

    /* WHAT WENT WRONG, KEPT APART FROM WHAT TO SAY ABOUT IT.

       A parent whose wifi is switched off and a parent whose school server is
       rebuilding are two different people with two different next actions.
       Telling somebody with no signal that the school is down sends them to
       ring the office about a fault that does not exist; telling somebody in
       a 502 to check their data has them toggling aeroplane mode in a queue.
       So the failure is classified once and every other decision reads it. */
    enum Failure {
        case noNetwork, unreachable, server

        var title: String {
            switch self {
            case .noNetwork: return L10n.offlineTitle
            case .unreachable: return L10n.unreachableTitle
            case .server: return L10n.serverTitle
            }
        }

        var body: String {
            switch self {
            case .noNetwork: return L10n.offlineBody
            case .unreachable: return L10n.unreachableBody
            case .server: return L10n.serverBody
            }
        }
    }

    struct Pull {
        var travel: CGFloat = 0
        var alpha: CGFloat = 0
        var visible = false
    }

    /* The app's own loading screen, in front of the page until it paints, and
       the dimmed picture of the last screen under it. */
    @Published private(set) var splashVisible = true
    @Published private(set) var snapshot: UIImage?

    @Published private(set) var failure: Failure?
    @Published private(set) var banner: String?
    /* What the toast says and, when it is about a file that now exists, the
       file, so a tap on the toast opens it. "Saved to Files" is a fact; a tap
       that shows the receipt is a use. */
    struct Toast: Equatable {
        var text: String
        var file: URL?
    }

    @Published private(set) var toast: Toast?
    @Published private(set) var progress: Double = 0
    @Published private(set) var loading = false
    @Published private(set) var locked = false
    @Published private(set) var pull = Pull()

    let webView: WKWebView
    let pullGesture = PullToRefresh()

    private let network = NetworkWatch()
    private let downloads = Downloads()
    private var observers: [NSKeyValueObservation] = []

    /* The last address that actually painted. Retry goes here rather than to
       the front door, and the cache fallback needs something to ask for. */
    private var lastGoodUrl: URL?

    /* True while a load has been deliberately aimed at the cache. It is what
       keeps the fallback from looping: a cache load that fails too comes back
       through the error path with this set, and that is the point where there
       is genuinely nothing to show and the panel is right. */
    private var servingCache = false

    /* True once something out of the cache is on screen: the page in front of
       the parent is a snapshot from earlier, so when the network returns it is
       worth reloading under them. */
    private var showingCached = false

    /* False until the page has painted something. */
    private var painted = false

    /* Where the page's scroller is, as last reported through the bridge.
       Starts false — "not at the top" — so nothing is offered until the page
       has actually said where it is; a bundle without the report, a screen
       still loading, gets no gesture rather than a gesture at the wrong
       moment. Refusing is the safe direction. */
    private var atTop = false

    private var foreground = false
    private var leftAt: Date?
    private var firstActivation = true
    private var prompting = false

    /* Taken when the scene goes inactive, kept only if it then goes to the
       background. See becameInactive for why the two moments are split. */
    private var pendingSnapshot: UIImage?
    private var bannerToken = 0
    private var toastToken = 0

    override init() {
        let config = WKWebViewConfiguration()
        // The session cookie has to survive the app being closed, or a parent
        // signs in every single time they open it.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.userContentController.addUserScript(WKUserScript(
            source: BridgeScript.source(appLock: AppLock.enabled, canLock: AppLock.available),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        /* The controller retains its handler and the web view retains the
           controller; a proxy keeps that from being a cycle through self. */
        config.userContentController.add(ScriptProxy(self), name: BridgeScript.handlerName)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        /* The system's 3D-touch link preview is a browser feature minus the
           browser: it peeks a page in a card this app cannot then open. */
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "PageBackground")
        webView.scrollView.backgroundColor = UIColor(named: "PageBackground")
        /* SwiftUI lays the view inside the safe area, which is the Android
           fitsSystemWindows answer: the site's header stays clear of the clock
           on every screen, and env(safe-area-inset-*) correctly reads zero so
           nothing is inset twice. The scroll view must not add its own. */
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        /* The keyboard follows the finger down when the page is scrolled,
           as it does in Safari and Messages. Without this a parent who has
           typed one field and wants to read the next has to find and tap the
           page's tiny "done" affordance first. */
        webView.scrollView.keyboardDismissMode = .interactive

        /* THE PAGE THAT STAYED ZOOMED. WebKit zooms in when a focused field's
           text is smaller than 16px and does not zoom back out when the field
           is left, so a parent who tapped the sign-in form saw every screen
           after it cropped at the right edge. The bridge script fixes the
           cause for pages it can style; this puts the scale back to one when
           the keyboard goes, for any page it could not. */
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let scroll = self?.webView.scrollView, scroll.zoomScale != 1 else { return }
            scroll.setZoomScale(1, animated: true)
        }

        observers.append(webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
            DispatchQueue.main.async { self?.progress = view.estimatedProgress }
        })
        observers.append(webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            DispatchQueue.main.async { self?.loading = view.isLoading }
        })

        pullGesture.canScrollUp = { [weak self] in !(self?.atTop ?? false) }
        pullGesture.onRefresh = { [weak self] in self?.webView.reload() }
        pullGesture.onChange = { [weak self] travel, alpha, visible in
            self?.pull = Pull(travel: travel, alpha: alpha, visible: visible)
        }
        webView.addGestureRecognizer(pullGesture.recognizer)

        downloads.onToast = { [weak self] text, file in self?.showToast(text, file: file) }
        downloads.isForeground = { [weak self] in self?.foreground ?? false }

        network.onReturn = { [weak self] in self?.networkReturned() }
        network.onLost = { [weak self] in
            /* A tile or an avatar failing is not a reason to replace a working
               screen with an error, but it is worth a word: a parent looking
               at a map with no tiles should be told the phone is offline
               rather than left deciding the bus has vanished. */
            guard let self, self.failure == nil, !self.splashVisible else { return }
            self.showBanner(L10n.bannerOffline)
        }
        network.start()

        restoreLastScreen()
        load(Portal.url)
    }

    deinit {
        network.stop()
    }

    // MARK: Loading

    func open(deepLink url: URL) {
        hideBanner()
        load(url)
    }

    private func load(_ url: URL) {
        failure = nil
        /* The panel switches the gesture off. Every path back to a live page
           has to switch it on again, or a parent who met one error keeps a
           page they can no longer pull to refresh for the rest of the day. */
        pullGesture.pullEnabled = true
        webView.load(URLRequest(url: url))
    }

    /* Retry goes back to the page that failed, not to the front door. A
       parent who lost signal on the fee screen wants the fee screen. */
    func retry() {
        failure = nil
        pullGesture.pullEnabled = true
        servingCache = false
        showingCached = false
        if let url = lastGoodUrl ?? webView.url {
            webView.load(URLRequest(url: url))
        } else {
            load(Portal.url)
        }
    }

    /* A load that painted. Worth recording where it was, and worth clearing
       whatever the last failure put on screen. */
    private func committed(_ url: URL?) {
        if let url, url.scheme != "about" { lastGoodUrl = url }
        painted = true
        hideSplash()
        /* A live page clears the stale flag: the flag describes what is on
           screen now, and what is on screen now is this page. */
        if !servingCache { showingCached = false }
        if servingCache {
            /* The cached copy is what is now in front of the parent. Say so:
               a stale fee balance presented as current is worse than no fee
               balance, because it is believed. */
            servingCache = false
            showingCached = true
            showBanner(network.hasNetwork ? L10n.bannerSlow : L10n.bannerOffline)
        }
    }

    /* THE MAIN FRAME FAILED, AND THE PANEL IS THE LAST ANSWER RATHER THAN THE
       FIRST. Replacing a screen the parent can read with a full page error is
       a worse outcome than the error, so the first thing tried is the disk:
       reload the same address through the cache, which on a phone that opened
       the bus screen this morning still holds the bundle. Only when that comes
       back empty as well is there genuinely nothing to show. */
    private func failed(_ kind: Failure) {
        if !servingCache, let url = lastGoodUrl {
            servingCache = true
            pullGesture.stopRefreshing()
            /* returnCacheDataElseLoad rather than the cache-only policy: it
               serves entries whose freshness has expired, which is nearly all
               of them given the portal sends its HTML no-cache, and still
               reaches the network for anything missing when there is one. */
            webView.load(URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 30))
            return
        }
        showOffline(kind)
    }

    private func showOffline(_ kind: Failure) {
        // An error the parent can act on beats a spinner that will not end.
        hideSplash()
        painted = true
        /* A pull that started this load has to be released here as well as on
           success, or a parent who pulls to refresh in a tunnel is left with a
           spinner that never stops on top of an error that explains itself. */
        pullGesture.stopRefreshing()
        // The panel has its own retry button; a second, invisible way to do
        // the same thing behind it is not an improvement.
        pullGesture.pullEnabled = false
        servingCache = false
        showingCached = false
        hideBanner()
        failure = kind
    }

    /* WHICH OF THE THREE THINGS WENT WRONG. The error alone cannot tell "the
       wifi is off" from "the school's box is not answering": both arrive as a
       failure to connect. The path monitor is the other half of the question,
       and it is asked first, because a phone with no network explains every
       code there is and is the one case where the parent can do something. */
    private func classify(_ error: Error) -> Failure? {
        let ns = error as NSError
        // The load was replaced by another, or turned into a download. Neither
        // is a failure anybody needs telling about.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return nil }
        // 102 is WebKit's "frame load interrupted by policy change": the load became a
        // download, or was cancelled for a 5xx above. Not exposed on WKError.Code.
        if ns.domain == WKErrorDomain && ns.code == 102 { return nil }
        if !network.hasNetwork { return .noNetwork }
        return .unreachable
    }

    private func networkReturned() {
        if failure != nil {
            retry()
            return
        }
        /* A stale snapshot with the network back is worth quietly replacing.
           Anything else already live is left alone, because reloading a page
           a parent is reading to tell them nothing new is worse than saying
           nothing. */
        if showingCached {
            showingCached = false
            showBanner(L10n.bannerBack)
            webView.reload()
        }
    }

    // MARK: Chrome

    /* Long enough to read one line while glancing at a bus map, short enough
       that it is not still covering the site's header when the parent goes to
       tap it. Dismissible by tapping for the same reason. */
    func showBanner(_ text: String) {
        bannerToken += 1
        let token = bannerToken
        banner = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if self?.bannerToken == token { self?.hideBanner() }
        }
    }

    func hideBanner() {
        bannerToken += 1
        banner = nil
    }

    private func showToast(_ text: String, file: URL? = nil) {
        toastToken += 1
        let token = toastToken
        toast = Toast(text: text, file: file)
        // A toast that can be tapped stays a little longer than one that only
        // informs: the parent has to read it, decide, and reach for it.
        let seconds: Double = file == nil ? 3.5 : 6
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            if self?.toastToken == token { self?.toast = nil }
        }
    }

    /* The toast was tapped: show the file it is about. */
    func openToast() {
        guard let file = toast?.file else { return }
        toastToken += 1
        toast = nil
        Presenter.preview(file)
    }

    private func hideSplash() {
        guard splashVisible else { return }
        splashVisible = false
        // The snapshot is the largest thing this app holds in memory and it
        // has no further use once the live page is up.
        snapshot = nil
    }

    private func restoreLastScreen() {
        if AppLock.enabled {
            LastScreen.clear()
            return
        }
        LastScreen.load { [weak self] image in
            DispatchQueue.main.async {
                guard let self, let image, self.splashVisible else { return }
                self.snapshot = image
            }
        }
    }

    // MARK: Lifecycle, from the scene phase

    func becameActive() {
        foreground = true
        pendingSnapshot = nil
        /* The Face ID sheet is system UI: raising it takes the scene to
           inactive and dismissing it brings it back to active, without ever
           passing through the background. So "how long were we away" is read
           only from a background stay, and a cold start counts as away for
           ever. Without this the successful unlock itself re-locks the app. */
        let coldStart = firstActivation
        firstActivation = false
        let away = leftAt.map { Date().timeIntervalSince($0) } ?? 0
        leftAt = nil
        guard AppLock.enabled, !locked else { return }
        if coldStart || away >= AppLock.lockAfter { showLock() }
    }

    /* THE PICTURE IS TAKEN HERE AND KEPT THERE.

       Inactive is the last moment the web view's own process is certain to
       still be rendering: by the time the scene reaches the background its
       snapshot may already be blank. But inactive also fires for the file
       picker, the Face ID sheet and a pull on the notification shade, and
       none of those is the parent leaving. So the picture is taken now and
       only written if the background transition actually follows; becoming
       active again throws it away. */
    func becameInactive() {
        guard failure == nil, painted, !splashVisible, !locked, !AppLock.enabled else { return }
        let bounds = webView.bounds
        guard bounds.width > 0 else { return }
        let config = WKSnapshotConfiguration()
        config.rect = bounds
        // Half width in points: it is only ever shown at a third of its
        // opacity, and it is the largest thing this app writes.
        config.snapshotWidth = NSNumber(value: Double(bounds.width / 2))
        config.afterScreenUpdates = false
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            self?.pendingSnapshot = image
        }
    }

    func wentToBackground() {
        foreground = false
        leftAt = Date()
        if let image = pendingSnapshot {
            pendingSnapshot = nil
            LastScreen.save(image)
        }
    }

    private func showLock() {
        locked = true
        askToUnlock()
    }

    func askToUnlock() {
        if prompting { return }
        prompting = true
        AppLock.ask { [weak self] ok in
            guard let self else { return }
            self.prompting = false
            if ok { self.locked = false }
        }
    }
}

// MARK: - The bridge

private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    private weak var shell: WebShell?

    init(_ shell: WebShell) {
        self.shell = shell
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        shell?.receive(message)
    }
}

extension WebShell {
    /* Same-origin is enforced in the navigation delegate — every foreign URL
       goes to Safari — so the only code that can reach this is the school's
       own bundle. Checked again here because a bridge is a hole in the wall
       and two locks on it cost nothing. */
    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host.lowercased() == Portal.host,
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }
        switch kind {
        case "atTop":
            atTop = (body["value"] as? Bool) ?? false
        case "appLock":
            AppLock.enabled = (body["value"] as? Bool) ?? false
        case "haptic":
            Haptics.play((body["value"] as? String) ?? "tap")
        default:
            break
        }
    }
}

// MARK: - Navigation

extension WebShell: WKNavigationDelegate {

    /* ANYTHING NOT THE SCHOOL OPENS IN SAFARI.

       A parent tapping the map attribution, or a payment gateway, or a mailto
       link, must not end up inside a chrome-less window with no address bar
       and no way back. Keeping a foreign page inside this shell is also how a
       wrapper becomes a phishing surface: there is nothing on screen to say
       which site is which.

       Sub-frames are the one place this differs from the Android shell, which
       sends a foreign iframe to the browser too. An iframe is embedded by the
       school's own page, on the school's own screen, and yanking the parent
       out to Safari because a widget on that screen loaded is a jolt with no
       safety behind it: the frame is still inside the portal's chrome. */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        /* THE EXPORT BUTTON THAT DID NOTHING. The portal builds a CSV or a
           PDF in the page and hands it over as an <a download> on a blob:
           URL. Treated as a navigation that is a blank screen at best; WebKit
           marks the click as a download request, and answering .download here
           is what turns it into a file in Files. Portal-origin only: a foreign
           page must not be able to drop files into the parent's folder. */
        if action.shouldPerformDownload, Portal.isPortal(action.sourceFrame.request.url) {
            decisionHandler(.download)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if Portal.isPortal(url) || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        if action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        Presenter.openExternal(url)
        decisionHandler(.cancel)
    }

    /* THE TAP THAT DID NOTHING, AND THE SERVER'S OWN FAILURE PAGE.

       An attachment — the receipt, the circular — cannot be rendered, and a
       web view with nobody asking for the download drops it on the floor
       without a sound. So an attachment disposition, or any type the view
       cannot show, becomes a download; see Downloads for the rest.

       The server answering the main frame with a 5xx is a deploy in progress
       or a fault, and a raw nginx 502 inside an app reads as the app being
       broken. Say what it is, and offer the retry that will work in a minute. */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let http = response.response as? HTTPURLResponse {
            if response.isForMainFrame && http.statusCode >= 500 {
                decisionHandler(.cancel)
                failed(.server)
                return
            }
            let disposition = http.value(forHTTPHeaderField: "Content-Disposition")
            let attachment = disposition?
                .drop(while: { $0 == " " || $0 == "\t" })
                .lowercased()
                .hasPrefix("attachment") == true
            if attachment || !response.canShowMIMEType {
                decisionHandler(.download)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.begin(download, response: navigationResponse.response)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.begin(download, response: nil)
    }

    /* Content is arriving, which is a different and much earlier moment than
       didFinish: a React app finishes loading long after it has painted
       something worth looking at. Revealing here is what keeps the splash
       from handing over to an empty frame. */
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed(webView.url)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pullGesture.stopRefreshing()
        committed(webView.url)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if let kind = classify(error) { failed(kind) } else { pullGesture.stopRefreshing() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if let kind = classify(error) { failed(kind) } else { pullGesture.stopRefreshing() }
    }

    /* The renderer is a separate process and the system kills it under
       memory pressure. Left unhandled the parent sees a white page for one
       they were only reading. The fix is the same URL again. */
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = webView.url ?? lastGoodUrl {
            webView.load(URLRequest(url: url))
        } else {
            load(Portal.url)
        }
    }
}

// MARK: - The controls a web view silently kills

extension WebShell: WKUIDelegate {

    /* target="_blank". There is no second tab to open it in: the portal's own
       pages load here, and anything else goes to Safari like every other
       foreign link. */
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if Portal.isPortal(url) {
            webView.load(action.request)
        } else {
            Presenter.openExternal(url)
        }
        return nil
    }

    /* alert(), confirm() and prompt() do nothing whatever in a WKWebView
       until the host draws them — not fail, not warn, simply not respond —
       and a confirm that never answers leaves the page waiting for ever. */
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        Presenter.alert(message, done: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Presenter.confirm(message, done: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        Presenter.prompt(prompt, initial: defaultText, done: completionHandler)
    }
}
