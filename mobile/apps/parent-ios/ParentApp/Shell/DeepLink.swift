import Foundation

/* A LINK IN A MESSAGE THAT OPENS THE APP AT THE THING IT NAMES.

   Schools send fee reminders and circulars by SMS and email with a link in
   them. With universal links set up (Config/Parent.entitlements, and the
   apple-app-site-association file the server has to serve) that link opens
   this app rather than Safari, so the parent does not meet the sign-in page
   a second time in a different place with a different session.

   The paths accepted are narrow on purpose, and match the Android manifest
   exactly. The portal's router owns very nearly every path there is, /api
   included; claiming the whole host would mean this app volunteering to open
   URLs that are not pages at all, and a parent who followed one would get raw
   JSON inside something wearing the school's icon. So: /go/, the site's own
   stable deep-link scheme; /account, where a "your fees are due" message
   wants to land; and the site root.

   A URL arriving here is untrusted input — any app on the phone can open one
   — so the scheme and host are checked as well as the path. Without that
   another app could point this shell at a page of its choosing, which is the
   phishing surface the foreign-host rule in WebShell exists to close, opened
   from the other end. */
enum DeepLink {
    static func accept(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "https", Portal.isPortal(url) else { return nil }
        let path = url.path.isEmpty ? "/" : url.path
        if path == "/" || path.hasPrefix("/account") || path.hasPrefix("/go/") {
            return url
        }
        return nil
    }
}
