import Foundation
import UniformTypeIdentifiers

/* WHAT TO CALL THE FILE, AND WHETHER IT WAS MEANT TO BE READ OR KEPT.

   The name arrives from a response header, which means it is server input
   and, on a system that stores uploaded filenames, ultimately something
   somebody typed. filename* comes first because that is the encoded form and
   the one that carries a name in Telugu or Hindi correctly; a school circular
   is routinely titled in the local language.

   Pure Foundation, no UIKit: this file is the one piece of the download path
   that can be checked on a Mac without an iOS toolchain, and it is the piece
   most likely to be wrong. */
enum ContentDisposition {
    /* RFC 6266: `filename*=UTF-8''name%20here` for anything not plain ASCII,
       `filename="name"` or a bare token otherwise. All three are seen from the
       same server depending on the name. */
    private static let extended = try! NSRegularExpression(
        pattern: #"filename\*\s*=\s*[^']*'[^']*'([^;\s]+)"#, options: [.caseInsensitive])
    private static let quoted = try! NSRegularExpression(
        pattern: #"filename\s*=\s*"([^"]*)""#, options: [.caseInsensitive])
    private static let plain = try! NSRegularExpression(
        pattern: #"filename\s*=\s*([^;\s"]+)"#, options: [.caseInsensitive])

    /* "inline" is the portal asking for this to be READ rather than kept.
       Anything else, including a header that could not be parsed, is treated
       as a keepsake, which is the safer of the two mistakes: an unwanted file
       in the folder is a nuisance, an unwanted viewer is a surprise. */
    static func isInline(_ header: String?) -> Bool {
        guard let header else { return false }
        return header.drop(while: { $0 == " " || $0 == "\t" }).lowercased().hasPrefix("inline")
    }

    static func fileName(header: String?, url: URL?, mime: String?, suggested: String?) -> String {
        var name: String? = nil
        if let header {
            if let raw = first(extended, in: header) {
                name = raw.removingPercentEncoding ?? raw
            } else if let q = first(quoted, in: header) {
                name = q
            } else if let p = first(plain, in: header) {
                name = p
            }
        }
        if name == nil || name!.trimmingCharacters(in: .whitespaces).isEmpty {
            name = suggested
        }
        if name == nil || name!.trimmingCharacters(in: .whitespaces).isEmpty {
            let last = url?.lastPathComponent ?? ""
            name = last.isEmpty || last == "/" ? "download" : last
        }
        return safeName(name!, mime: mime)
    }

    /* A NAME THE FILE SYSTEM WILL TAKE AND THE HEADER CANNOT AIM.

       A slash in the name would send the write out of the downloads folder,
       so the path separators are stripped before anything else, and what is
       left is reduced to characters a phone will display and a share sheet
       will not mangle. A file with no extension is one the phone offers no
       app for, which after all this work is a saved receipt the parent cannot
       open, so one is added from the MIME type where it is missing. */
    static func safeName(_ raw: String, mime: String?) -> String {
        var base = raw
        if let i = base.lastIndex(of: "/") { base = String(base[base.index(after: i)...]) }
        if let i = base.lastIndex(of: "\\") { base = String(base[base.index(after: i)...]) }
        var cleaned = ""
        for scalar in base.unicodeScalars {
            let v = scalar.value
            let ok = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
                || scalar == "." || scalar == "_" || scalar == "-" || scalar == " "
                || scalar == "(" || scalar == ")" || (v >= 0x80 && v <= 0xFFFF)
            cleaned.unicodeScalars.append(ok ? scalar : "_")
        }
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        cleaned = cleaned.trimmingCharacters(in: .whitespaces)
        if cleaned.count > 100 { cleaned = String(cleaned.prefix(100)) }
        if cleaned.isEmpty { cleaned = "download" }
        if cleaned.contains(".") { return cleaned }
        if let mime, let type = UTType(mimeType: mime), let ext = type.preferredFilenameExtension {
            return cleaned + "." + ext
        }
        return cleaned
    }

    private static func first(_ re: NSRegularExpression, in s: String) -> String? {
        let range = NSRange(s.startIndex..., in: s)
        guard let m = re.firstMatch(in: s, range: range), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }
}
