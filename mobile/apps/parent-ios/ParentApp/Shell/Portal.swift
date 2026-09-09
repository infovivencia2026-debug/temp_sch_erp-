import Foundation

/* ONE DEPLOYMENT, ONE ADDRESS, COMPILED IN.

   Both values come from Config/Portal.xcconfig by way of Info.plist. The
   Android shell learned from the bus tracker that a field asking a parent for
   a server address is a field they can only get wrong, so neither shell has
   one: the address is a build setting, and this is the single place the app
   reads it. */
enum Portal {
    static let url: URL = {
        let raw = Bundle.main.object(forInfoDictionaryKey: "PortalURL") as? String
        guard let raw, let url = URL(string: raw), url.host != nil else {
            preconditionFailure("PortalURL is missing from Info.plist; set PORTAL_URL in Config/Portal.xcconfig")
        }
        return url
    }()

    /* The host, for the two filters that keep this a shell for one site:
       anything else opens in Safari, and a link arriving from another app
       must name this host or it is ignored. Derived from the URL rather than
       read from the second plist key, so the two cannot disagree. */
    static let host: String = url.host!.lowercased()

    /* EVERY OTHER NAME THE SAME SCHOOL ANSWERS ON.

       One host compared against the compiled-in address is right until the
       site moves, and then it is the worst possible wrong: the old name
       answers 301 to the new one, a redirect is a navigation, so the shell
       asks "is this the school?", gets no because the host changed, and does
       what it does with a foreign page -- opens Safari and leaves its own
       window empty. The app becomes a shortcut to the browser.

       PortalAliases is an optional comma-separated Info.plist key, so a
       deployment that has never moved sets nothing. */
    static let hosts: Set<String> = {
        var all: Set<String> = [host]
        let raw = Bundle.main.object(forInfoDictionaryKey: "PortalAliases") as? String ?? ""
        for name in raw.split(separator: ",") {
            let trimmed = name.trimmingCharacters(in: .whitespaces).lowercased()
            if !trimmed.isEmpty { all.insert(trimmed) }
        }
        return all
    }()

    static func isPortal(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return Portal.hosts.contains(host)
    }
}
