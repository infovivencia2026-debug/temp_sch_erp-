import UIKit

/* A PICTURE OF WHERE THE PARENT WAS, TO PUT UNDER THE NEXT COLD START.

   A shell has nothing of its own to show while the bundle downloads. On the
   mobile data a parent actually has that is several seconds, and every one
   of them is a flat coloured rectangle. So the last screen on the display
   when the app went away is kept as one image, and the next cold start puts
   it back, dimmed, behind the mark and the spinner. It is scenery, not data:
   nothing on it responds to a tap, and it is replaced the instant the real
   page paints.

   The one case where it is wrong is a parent who has turned the app lock on:
   they have asked that the portal not be visible without their face or
   fingerprint, and a photograph of it under the lock panel would be exactly
   that. So the lock deletes this file and nothing writes it while it is on.

   Anything older than half a day is deleted unseen rather than shown: a
   picture of a bus that was somewhere yesterday is worse than no picture.

   Kept in Application Support rather than Documents, because Documents is
   exposed to the Files app for downloads and a parent browsing their receipts
   should not find a screenshot of the app among them. Excluded from backup
   for the same reason a cache is. */
enum LastScreen {
    private static let name = "last_screen.jpg"
    private static let maxAge: TimeInterval = 12 * 60 * 60

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name)
    }

    /* The image comes from WKWebView.takeSnapshot, taken by the shell at the
       moment it is still sure to be rendering; only the compress and the
       write happen here, off the main thread. */
    static func save(_ image: UIImage) {
        let target = file
        DispatchQueue.global(qos: .utility).async {
            guard let data = image.jpegData(compressionQuality: 0.7) else { return }
            let tmp = target.appendingPathExtension("tmp")
            do {
                try data.write(to: tmp, options: .atomic)
                /* Written aside and renamed so a cold start can never decode a
                   half-written file and show the top third of a fee list. */
                _ = try? FileManager.default.removeItem(at: target)
                try FileManager.default.moveItem(at: tmp, to: target)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var url = target
                try? url.setResourceValues(values)
            } catch {
                try? FileManager.default.removeItem(at: tmp)
            }
        }
    }

    /* Off the main thread, because it runs during the launch, which is the
       one stretch this whole file is about. Arriving after the page has
       painted is fine and common on wifi: the splash is gone by then and the
       picture is never shown. */
    static func load(_ done: @escaping (UIImage?) -> Void) {
        let target = file
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            guard fm.fileExists(atPath: target.path) else { done(nil); return }
            let modified = (try? fm.attributesOfItem(atPath: target.path)[.modificationDate] as? Date) ?? .distantPast
            if Date().timeIntervalSince(modified) > maxAge {
                try? fm.removeItem(at: target)
                done(nil)
                return
            }
            done(UIImage(contentsOfFile: target.path))
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: file)
    }
}
