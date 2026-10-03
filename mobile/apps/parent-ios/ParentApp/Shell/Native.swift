import BackgroundTasks
import Foundation
import Security
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import VisionKit
import WebKit

/* THE PHONE'S HALF OF window.ErpShell, VERSION 2 (docs/native-shell.md).

   BridgeScript builds the object the page sees; its version-2 calls post a
   message that WebShell.receive hands here, and answers go back as the page's
   `erp-shell` event (WebShell.emit). The synchronous getters (storeKey, school,
   downloaded) are answered from state injected at document start.

   On disk, all in Application Support (excluded from backup):
     outbox.json   the page's waiting writes, sent by a BGProcessingTask
     offline/      lesson files and videos saved for offline, shown to the
                   page as xulo-file://<hash> through OfflineFiles
   The store key is in the Keychain, this device only. */
enum Native {
    static let outboxTask = "com.xulo.outbox"

    static var supportDir: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    // MARK: Store key (Keychain)

    private static let keyAccount = "xulo-store-key"

    static func storeKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keyAccount,
            kSecReturnData as String: true,
        ]
        var out: AnyObject?
        if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let d = out as? Data {
            return d.base64EncodedString()
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, &bytes) == errSecSuccess else { return nil }
        let data = Data(bytes)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keyAccount,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? data.base64EncodedString() : nil
    }

    /// A remote sign-out: everything this app kept for the person.
    static func wipe() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: keyAccount] as CFDictionary)
        try? FileManager.default.removeItem(at: supportDir.appendingPathComponent("outbox.json"))
        try? FileManager.default.removeItem(at: OfflineFiles.dir)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: outboxTask)
    }

    // MARK: Badge

    static func setBadge(_ n: Int) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(max(0, n))
        } else {
            UIApplication.shared.applicationIconBadgeNumber = max(0, n)
        }
    }

    // MARK: Outbox, sent with the app in the background

    /* The page sends its waiting writes here each time they change. The copy
       is sent by a BGProcessingTask that needs a network, oldest first, with
       the page's own Idempotency-Key; the page replays them again when it is
       next open and the server answers with what it stored. Cookies are copied
       from the web view's store, which a background URLSession cannot see. */
    static func outboxChanged(_ json: String, origin: URL, cookies: WKHTTPCookieStore) {
        guard let data = json.data(using: .utf8),
              let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
        let keep = rows.filter { ($0["path"] as? String)?.hasPrefix("/api/") == true }.map {
            ["key": $0["key"] ?? "", "method": $0["method"] ?? "POST", "path": $0["path"] ?? "", "body": $0["body"] ?? ""]
        }
        let file = supportDir.appendingPathComponent("outbox.json")
        let doc: [String: Any] = ["origin": origin.absoluteString, "rows": keep]
        try? JSONSerialization.data(withJSONObject: doc).write(to: file, options: .completeFileProtectionUntilFirstUserAuthentication)
        cookies.getAllCookies { all in
            for c in all where origin.host?.hasSuffix(c.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true {
                HTTPCookieStorage.shared.setCookie(c)
            }
        }
        if keep.isEmpty {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: outboxTask)
        } else {
            let req = BGProcessingTaskRequest(identifier: outboxTask)
            req.requiresNetworkConnectivity = true
            try? BGTaskScheduler.shared.submit(req)
        }
    }

    /// Registered once at launch (ParentApp.init).
    static func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: outboxTask, using: nil) { task in
            let work = Task {
                let left = await sendOutbox()
                task.setTaskCompleted(success: !left)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    /// True when rows are left to send.
    static func sendOutbox() async -> Bool {
        let file = supportDir.appendingPathComponent("outbox.json")
        guard let data = try? Data(contentsOf: file),
              var doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let origin = (doc["origin"] as? String).flatMap(URL.init(string:)),
              let rows = doc["rows"] as? [[String: String]] else { return false }
        var sent = 0
        for r in rows {
            guard let path = r["path"], let url = URL(string: path, relativeTo: origin) else { sent += 1; continue }
            var req = URLRequest(url: url)
            req.httpMethod = r["method"] ?? "POST"
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.setValue(r["key"], forHTTPHeaderField: "Idempotency-Key")
            if let body = r["body"], !body.isEmpty {
                req.httpBody = body.data(using: .utf8)
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            guard let (_, res) = try? await URLSession.shared.data(for: req),
                  let http = res as? HTTPURLResponse, http.statusCode < 500 else { break }
            sent += 1
        }
        doc["rows"] = Array(rows.dropFirst(sent))
        if let out = try? JSONSerialization.data(withJSONObject: doc) { try? out.write(to: file) }
        return sent < rows.count
    }

    // MARK: Shared from other apps (Share Extension)

    /* The Share Extension (ShareExtension/) copies what was shared into the
       app group's inbox folder and opens xulo://share. The app reads the
       folder when it becomes active and hands the files to the page. */
    static var appGroup: String { "group." + (Bundle.main.bundleIdentifier ?? "com.schoolerp.parent") }

    static func takeShared() -> [String: Any]? {
        guard let box = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("inbox", isDirectory: true),
              let names = try? FileManager.default.contentsOfDirectory(at: box, includingPropertiesForKeys: nil),
              !names.isEmpty else { return nil }
        let files: [[String: String]] = names.prefix(10).compactMap { fileJSON($0) }
        names.forEach { try? FileManager.default.removeItem(at: $0) }
        return files.isEmpty ? nil : ["type": "share", "files": files]
    }

    static func fileJSON(_ url: URL) -> [String: String]? {
        guard let data = try? Data(contentsOf: url), data.count <= 20 * 1024 * 1024 else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return ["name": url.lastPathComponent, "type": type, "data": data.base64EncodedString()]
    }
}

// MARK: - Files saved for offline

/* Lesson files and videos, fetched with the session cookie and served to the
   page from disk under xulo-file://<hash>, so a saved video plays on a bus. */
final class OfflineFiles: NSObject, WKURLSchemeHandler {
    static var dir: URL {
        let d = Native.supportDir.appendingPathComponent("offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        var v = URLResourceValues()
        v.isExcludedFromBackup = true
        var m = d
        try? m.setResourceValues(v)
        return d
    }

    static func name(_ url: String) -> String {
        var h: UInt64 = 1469598103934665603
        for b in url.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        var h2: UInt64 = 14695981039346656037
        for b in url.utf8.reversed() { h2 = (h2 ^ UInt64(b)) &* 1099511628211 }
        return String(format: "%016llx%016llx", h, h2)
    }

    static func local(_ url: String) -> String? {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(name(url)).path) ? "xulo-file://\(name(url))" : nil
    }

    static func remove(_ url: String) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(name(url)))
    }

    static func download(_ url: URL, cookies: WKHTTPCookieStore, done: @escaping (Bool) -> Void) {
        cookies.getAllCookies { all in
            var req = URLRequest(url: url)
            let header = HTTPCookie.requestHeaderFields(with: all.filter { url.host?.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true })
            header.forEach { req.setValue($1, forHTTPHeaderField: $0) }
            URLSession.shared.downloadTask(with: req) { tmp, res, _ in
                let ok = (res as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                guard ok, let tmp else { DispatchQueue.main.async { done(false) }; return }
                let target = dir.appendingPathComponent(name(url.absoluteString))
                try? FileManager.default.removeItem(at: target)
                let moved = (try? FileManager.default.moveItem(at: tmp, to: target)) != nil
                if moved, let type = res?.mimeType {
                    try? type.write(to: target.appendingPathExtension("type"), atomically: true, encoding: .utf8)
                }
                DispatchQueue.main.async { done(moved) }
            }.resume()
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let host = task.request.url?.host, host.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let file = OfflineFiles.dir.appendingPathComponent(host)
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let type = (try? String(contentsOf: file.appendingPathExtension("type"), encoding: .utf8)) ?? "application/octet-stream"
        task.didReceive(URLResponse(url: task.request.url!, mimeType: type, expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Camera, document scan, files

/* One picker at a time; the answer goes to the page as a 'picked' event. */
final class Picker: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate,
    UIDocumentPickerDelegate, VNDocumentCameraViewControllerDelegate {
    static let shared = Picker()
    private var id = ""
    private var answer: (String, [[String: String]]) -> Void = { _, _ in }

    func pick(id: String, kind: String, accept: String, answer: @escaping (String, [[String: String]]) -> Void) {
        self.id = id
        self.answer = answer
        guard let top = Presenter.top else { answer(id, []); return }
        switch kind {
        case "scan" where VNDocumentCameraViewController.isSupported:
            let vc = VNDocumentCameraViewController()
            vc.delegate = self
            top.present(vc, animated: true)
        case "camera" where UIImagePickerController.isSourceTypeAvailable(.camera), "scan":
            let vc = UIImagePickerController()
            vc.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
            vc.delegate = self
            top.present(vc, animated: true)
        default:
            let types: [UTType] = accept.contains("image") ? [.image] : accept.contains("pdf") ? [.pdf] : [.item]
            let vc = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            vc.allowsMultipleSelection = true
            vc.delegate = self
            top.present(vc, animated: true)
        }
    }

    private func finish(_ files: [[String: String]]) {
        answer(id, files)
        answer = { _, _ in }
    }

    private func jpeg(_ image: UIImage, name: String) -> [String: String]? {
        guard let d = image.jpegData(compressionQuality: 0.85) else { return nil }
        return ["name": name, "type": "image/jpeg", "data": d.base64EncodedString()]
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        let image = info[.originalImage] as? UIImage
        finish(image.flatMap { jpeg($0, name: "photo.jpg") }.map { [$0] } ?? [])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish([])
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.prefix(10).compactMap { Native.fileJSON($0) })
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish([]) }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: true)
        finish((0..<min(scan.pageCount, 10)).compactMap { jpeg(scan.imageOfPage(at: $0), name: "scan-\($0 + 1).jpg") })
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
        finish([])
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true)
        finish([])
    }
}

// MARK: - Push (APNs)

/* The device token, kept for the page (ErpShell.pushToken, lib/push.ts) and
   handed to it as a 'push' event when it changes. Registering needs the
   aps-environment entitlement and the owner's APNs key on the server. */
final class AppDelegate: NSObject, UIApplicationDelegate {
    static var onToken: (String) -> Void = { _ in }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Native.registerBackgroundTasks()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted { DispatchQueue.main.async { application.registerForRemoteNotifications() } }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: "push_token")
        AppDelegate.onToken(hex)
    }
}
