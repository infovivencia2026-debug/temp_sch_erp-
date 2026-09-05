import UIKit
import QuickLook
import SafariServices

/* The one UIKit seam a SwiftUI shell needs: something to present a system
   sheet from. Used for the page's own alert/confirm/prompt dialogs, which a
   WKWebView silently drops unless the host draws them, and for showing a
   downloaded document the parent asked to read. */
enum Presenter {
    static var top: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        guard var vc = window?.rootViewController else { return nil }
        while let next = vc.presentedViewController { vc = next }
        return vc
    }

    static func alert(_ message: String, done: @escaping () -> Void) {
        guard let host = top else { done(); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
        host.present(alert, animated: true)
    }

    static func confirm(_ message: String, done: @escaping (Bool) -> Void) {
        guard let host = top else { done(false); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(true) })
        host.present(alert, animated: true)
    }

    static func prompt(_ message: String, initial: String?, done: @escaping (String?) -> Void) {
        guard let host = top else { done(nil); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addTextField { $0.text = initial }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            done(alert.textFields?.first?.text ?? "")
        })
        host.present(alert, animated: true)
    }

    /* A FOREIGN PAGE, SHOWN WITH ITS ADDRESS.

       The rule in WebShell is that nothing but the school is rendered inside
       the shell, because a chrome-less window with no address bar is a
       phishing surface. Leaving the app for Safari satisfies the rule and
       loses the parent: they tap a payment gateway or a map credit, land in
       another app, and come back by the app switcher if they come back at all.

       SFSafariViewController is Safari's own view, inside this app, with the
       real address bar, the lock icon and a Done button that returns to the
       exact screen. It is the platform's answer to precisely this case and
       is what Android's Custom Tabs would be. Non-web schemes -- tel:,
       mailto:, whatsapp: -- go to the app that owns them, as before. */
    static func openExternal(_ url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "http" || scheme == "https", let host = top else {
            UIApplication.shared.open(url)
            return
        }
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let safari = SFSafariViewController(url: url, configuration: config)
        safari.dismissButtonStyle = .done
        safari.preferredControlTintColor = UIColor(named: "PageText")
        host.present(safari, animated: true)
    }

    /* A document handed to something that can draw one. False when there is
       nothing to present from, and the caller then falls back to saying where
       the file is, because a parent who can be told "it is in Files" can still
       open it from there. */
    @discardableResult
    static func preview(_ file: URL) -> Bool {
        guard let host = top, QLPreviewController.canPreview(file as QLPreviewItem) else { return false }
        host.present(FilePreview(file), animated: true)
        return true
    }
}

private final class FilePreview: QLPreviewController, QLPreviewControllerDataSource {
    private let file: URL

    init(_ file: URL) {
        self.file = file
        super.init(nibName: nil, bundle: nil)
        dataSource = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        file as QLPreviewItem
    }
}
