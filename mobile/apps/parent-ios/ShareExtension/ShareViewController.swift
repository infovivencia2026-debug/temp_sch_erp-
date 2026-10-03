import UIKit
import UniformTypeIdentifiers

/* SHARING A PHOTO OR A PDF INTO THE APP.

   The Share Extension target. It copies what was shared (up to 10 images,
   videos or PDFs, 20 MB each) into the app group's inbox folder and opens the
   app with xulo://share; the app hands the files to the page when it becomes
   active (Native.takeShared), and the page asks where they go
   (web/src/components/ShareInbox.tsx). Nothing is sent from here. */
final class ShareViewController: UIViewController {
    private var group: String {
        let main = (Bundle.main.bundleIdentifier ?? "").replacingOccurrences(of: ".share", with: "")
        return "group." + main
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await copyAndOpen() }
    }

    private func copyAndOpen() async {
        guard let box = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("inbox", isDirectory: true) else { return done() }
        try? FileManager.default.createDirectory(at: box, withIntermediateDirectories: true)
        let items = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var n = 0
        for p in items where n < 10 {
            for type in [UTType.image, .movie, .pdf] where p.hasItemConformingToTypeIdentifier(type.identifier) {
                if let url = try? await p.loadItem(forTypeIdentifier: type.identifier) as? URL,
                   let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 20 * 1024 * 1024 {
                    let target = box.appendingPathComponent("\(n)-\(url.lastPathComponent)")
                    try? FileManager.default.copyItem(at: url, to: target)
                    n += 1
                }
                break
            }
        }
        if n > 0, let open = URL(string: "xulo://share") { openApp(open) }
        done()
    }

    /* An extension has no UIApplication; the responder chain reaches the
       host's openURL. */
    private func openApp(_ url: URL) {
        var r: UIResponder? = self
        while let next = r {
            if let app = next as? UIApplication {
                app.open(url)
                return
            }
            r = next.next
        }
    }

    private func done() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
