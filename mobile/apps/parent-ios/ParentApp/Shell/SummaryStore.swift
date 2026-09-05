import Foundation
import WebKit

/* WHAT THE PARENT SEES WHEN THERE IS NOTHING TO SEE.

   The shell's answer to no network was an error panel, and the cache
   fallback behind it works only for pages this phone has already opened. A
   parent on a bus with no signal opened the app and read "No connection" over
   a blank ground, which is a true sentence and a useless screen: the fee that
   was due yesterday and the exam that is tomorrow have not changed since the
   phone last had a signal, and the phone knows both.

   So the shell keeps its own copy of the parent's summary — the same JSON the
   portal's home screen is built from, one entry per child: attendance, fees
   outstanding, homework due, the next exam or the last result, today's
   periods — and the offline panel draws it natively. Not a cached page: a
   cached page is the moment it was cached, with a spinner in it. This is the
   figures, with the time they were true.

   FETCHED WITH THE PAGE'S OWN SESSION. The web view holds the login cookie;
   the store asks WebKit for its cookies and sends the one request with them,
   so there is no second sign-in and no credential kept anywhere else. A 401
   is the parent having signed out, and the copy is deleted on the spot: a
   summary shown after sign-out would be the app leaking the last account to
   the next.

   Refreshed at most every five minutes while the portal is in front, and on
   the way to the background, which is the last moment before the signal is
   lost. Kept in Application Support like the snapshot, excluded from backup
   for the same reason. */
final class SummaryStore {

    struct Period: Codable, Identifiable {
        var period: String
        var startsAt: String?
        var endsAt: String?
        var subject: String
        var teacher: String?
        var room: String?
        var id: String { period + subject }

        enum CodingKeys: String, CodingKey {
            case period, subject, teacher, room
            case startsAt = "starts_at"
            case endsAt = "ends_at"
        }
    }

    struct Child: Codable, Identifiable {
        var studentId: String
        var fullName: String
        var attendancePct: Int
        var presentDays: Int
        var totalDays: Int
        var absentDays: Int
        var homeworkDue: Int
        var nextHomeworkDue: String?
        var nextHomeworkTitle: String?
        var outstandingPaise: Int64
        var nextExam: String?
        var latestResultExam: String?
        var latestResultPct: Double?
        var latestResultGrade: String?
        // Go writes a nil slice as null; a child with no periods today must still decode.
        var today: [Period]?
        var id: String { studentId }

        enum CodingKeys: String, CodingKey {
            case today
            case studentId = "student_id"
            case fullName = "full_name"
            case attendancePct = "attendance_pct"
            case presentDays = "present_days"
            case totalDays = "total_days"
            case absentDays = "absent_days"
            case homeworkDue = "homework_due"
            case nextHomeworkDue = "next_homework_due"
            case nextHomeworkTitle = "next_homework_title"
            case outstandingPaise = "outstanding_paise"
            case nextExam = "next_exam"
            case latestResultExam = "latest_result_exam"
            case latestResultPct = "latest_result_pct"
            case latestResultGrade = "latest_result_grade"
        }
    }

    struct Saved: Codable {
        var children: [Child]
        var fetchedAt: Date
    }

    private struct StudentList: Decodable {
        struct Item: Decodable {
            var studentId: String
            enum CodingKeys: String, CodingKey { case studentId = "student_id" }
        }
        var items: [Item]
    }

    /* Called on the main thread whenever the copy changes, including at load. */
    var onChange: (Saved?) -> Void = { _ in }

    private(set) var saved: Saved?
    private var lastAttempt: Date = .distantPast
    private var inFlight = false
    private let minInterval: TimeInterval = 5 * 60

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("offline-summary.json")
    }

    init() {
        load()
    }

    private func load() {
        let target = SummaryStore.file
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let data = try? Data(contentsOf: target),
                  let saved = try? JSONDecoder.iso.decode(Saved.self, from: data) else { return }
            DispatchQueue.main.async {
                guard let self, self.saved == nil else { return }
                self.saved = saved
                self.onChange(saved)
            }
        }
    }

    /* Ask for a fresh copy, using the web view's cookies. Throttled; a no-op
       when one is already in flight or the last one was recent. `force` is
       for the moment before the background, which is worth a request even if
       the last was four minutes ago. */
    func refresh(from webView: WKWebView, force: Bool = false) {
        guard !inFlight else { return }
        if !force, Date().timeIntervalSince(lastAttempt) < minInterval { return }
        inFlight = true
        lastAttempt = Date()
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            // Cookie domains may carry a leading dot; the portal host does not.
            let mine = cookies.filter { cookie in
                let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                return domain.lowercased() == Portal.host
            }
            guard !mine.isEmpty else {
                // Not signed in: nothing to ask for, and nothing to keep.
                NSLog("summary: no portal cookies among %d", cookies.count)
                self.inFlight = false
                self.clear()
                return
            }
            // One request for the children, then one summary per child: the
            // summary endpoint answers for a single student.
            let headers = HTTPCookie.requestHeaderFields(with: mine)
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil
            config.httpShouldSetCookies = false
            let session = URLSession(configuration: config)
            let get: (URL, @escaping (Int, Data?) -> Void) -> Void = { url, done in
                var request = URLRequest(url: url)
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
                request.timeoutInterval = 20
                session.dataTask(with: request) { data, response, _ in
                    done((response as? HTTPURLResponse)?.statusCode ?? 0, data)
                }.resume()
            }
            get(Portal.url.appendingPathComponent("api/v1/portal/students")) { [weak self] status, data in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == 401 || status == 403 {
                        NSLog("summary: signed out (%d)", status)
                        self.inFlight = false
                        self.clear()
                        return
                    }
                    guard status == 200, let data,
                          let list = try? JSONDecoder().decode(StudentList.self, from: data) else {
                        NSLog("summary: students http %d", status)
                        self.inFlight = false
                        return
                    }
                    let ids = list.items.map(\.studentId)
                    guard !ids.isEmpty else { self.inFlight = false; self.clear(); return }
                    var children = [String: Child]()
                    let group = DispatchGroup()
                    for id in ids {
                        group.enter()
                        var comps = URLComponents(url: Portal.url.appendingPathComponent("api/v1/portal/summary"), resolvingAgainstBaseURL: false)!
                        comps.queryItems = [URLQueryItem(name: "student_id", value: id)]
                        get(comps.url!) { status, data in
                            DispatchQueue.main.async {
                                defer { group.leave() }
                                guard status == 200, let data else { NSLog("summary: child http %d", status); return }
                                do { children[id] = try JSONDecoder().decode(Child.self, from: data) } catch {
                                    NSLog("summary: decode failed: %@", String(describing: error))
                                }
                            }
                        }
                    }
                    group.notify(queue: .main) { [weak self] in
                        guard let self else { return }
                        self.inFlight = false
                        let ordered = ids.compactMap { children[$0] }
                        guard !ordered.isEmpty else { return }
                        let saved = Saved(children: ordered, fetchedAt: Date())
                        self.saved = saved
                        self.onChange(saved)
                        self.persist(saved)
                    }
                }
            }
        }
    }

    private func persist(_ saved: Saved) {
        let target = SummaryStore.file
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? JSONEncoder.iso.encode(saved) else { return }
            let tmp = target.appendingPathExtension("tmp")
            do {
                try data.write(to: tmp, options: .atomic)
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

    /* Signed out, or the account changed. The copy goes the same moment. */
    func clear() {
        saved = nil
        onChange(nil)
        try? FileManager.default.removeItem(at: SummaryStore.file)
    }
}

private extension JSONDecoder {
    static var iso: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

private extension JSONEncoder {
    static var iso: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}
