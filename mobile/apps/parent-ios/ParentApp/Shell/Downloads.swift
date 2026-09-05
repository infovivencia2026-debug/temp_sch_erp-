import Foundation
import WebKit

/* THE DOWNLOAD, FROM THE TAP TO THE FILE THE PARENT CAN STILL FIND NEXT MONTH.

   An attachment is the receipt and the circular: the server sends
   Content-Disposition attachment and the web view will not render it. Left
   unhandled the tap does nothing at all, which is the worst possible answer.
   WebShell turns those responses into a WKDownload and this is what happens
   to it.

   WHY THIS IS SIMPLER THAN THE ANDROID VERSION. WKDownload runs inside the
   web view's own session, so the login cookie travels with it for free; there
   is no second network stack with an empty cookie jar to hand the session to
   by hand. And WKWebView draws PDFs itself, so a circular the portal frames
   inline (?inline=1) is simply shown, where Android had to save it and find a
   reader. What is left for this file is a non-renderable inline document — a
   spreadsheet, a Word file — which is saved and then shown with Quick Look,
   because the parent asked to read it, not to keep it.

   WHERE IT GOES. The app's Documents folder, which Info.plist exposes to the
   Files app as "On My iPhone › EDU CLOUD". That is the iOS equivalent of the
   public Downloads folder: a receipt is kept in order to be produced later —
   forwarded on WhatsApp, shown at the office — and a file no other app can
   see is not kept, it is held until the phone changes its mind. */
final class Downloads: NSObject, WKDownloadDelegate {

    /* Text to say, and the file it is about once that file exists, so the
       shell can make the toast a way to open it. */
    var onToast: (String, URL?) -> Void = { _, _ in }
    var isForeground: () -> Bool = { true }

    private struct Record {
        var name: String
        var toRead: Bool
        var file: URL?
    }

    private var records: [ObjectIdentifier: Record] = [:]

    static var folder: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /* Called by the shell with the response that became this download, so
       the name and the read-or-keep decision are taken from the header the
       server actually sent rather than from WebKit's guess. */
    func begin(_ download: WKDownload, response: URLResponse?) {
        download.delegate = self
        let http = response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition")
        let name = ContentDisposition.fileName(
            header: disposition,
            url: response?.url,
            mime: response?.mimeType,
            suggested: response?.suggestedFilename
        )
        records[ObjectIdentifier(download)] = Record(name: name, toRead: ContentDisposition.isInline(disposition))
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let id = ObjectIdentifier(download)
        if records[id] == nil { begin(download, response: response) }
        var record = records[id]!
        let target = Downloads.folder.appendingPathComponent(record.name)
        /* WKDownload refuses a destination that already exists. A receipt
           downloaded twice is the same receipt; replacing it is what the
           parent expects, and a "(1)" suffix would leave them guessing which
           of two identical files is real. */
        try? FileManager.default.removeItem(at: target)
        record.file = target
        records[id] = record
        onToast(L10n.downloadStarted(record.name), nil)
        completionHandler(target)
    }

    /* Where it went, once it is actually there. The toast at the start is a
       promise and this is the receipt for it: a download that fails halfway
       on a connection that drops would otherwise leave the parent believing
       they have a copy of a fee receipt that does not exist. */
    func downloadDidFinish(_ download: WKDownload) {
        guard let record = records.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // The parent asked to read this, not to file it. Try to show it. Only
        // while the app is in front: a sheet presented over another app is
        // dropped by the system without a word.
        if record.toRead, isForeground(), let file = record.file, Presenter.preview(file) { return }
        onToast(L10n.downloadSaved(record.name), record.file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let record = records.removeValue(forKey: ObjectIdentifier(download)) else { return }
        if let file = record.file { try? FileManager.default.removeItem(at: file) }
        onToast(L10n.downloadFailed(record.name), nil)
    }

    /* A download that lands on another host must not carry this origin's
       session with it, for the same reason WebShell sends foreign pages to
       Safari. */
    func download(
        _ download: WKDownload,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
    ) {
        decisionHandler(Portal.isPortal(request.url) ? .allow : .cancel)
    }
}
