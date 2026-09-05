import Foundation

/* Every sentence the shell says itself. The Android app keeps these in
   res/values/strings.xml; the wording here is the same, so a family with one
   phone of each kind is told the same thing by both. */
enum L10n {
    static let appName = "EDU CLOUD"

    static let offlineTitle = "No connection"
    static let offlineBody = "This app shows the school's own site, so it needs the internet. Check your data or wifi and try again."
    /* Said differently from "no connection" because the parent who reads the
       wrong one of these two turns their wifi off and on for nothing. */
    static let unreachableTitle = "Cannot reach the school"
    static let unreachableBody = "Your phone is online but the school's site did not answer. This is usually the connection being slow rather than anything you did."
    static let serverTitle = "The school's site is down"
    static let serverBody = "The school's site is not answering right now. It is usually back within a minute."

    static let bannerOffline = "No connection. Showing what was saved earlier."
    static let bannerSlow = "Could not refresh. Showing what was saved earlier."
    static let bannerBack = "Back online."
    static let waitingForNetwork = "Waiting for the connection. This will reload by itself."
    static let retry = "Try again"
    static let open = "Open"

    /* Said at the tap and again at the end. The parent is on mobile data and
       the two are half a minute apart; a tap that acknowledges nothing is a
       tap that gets repeated. */
    static func downloadStarted(_ name: String) -> String { "Downloading \(name)" }
    static func downloadSaved(_ name: String) -> String { "Saved to Files › \(appName): \(name)" }
    static func downloadFailed(_ name: String) -> String { "Could not download \(name). Check your connection and try again." }

    static let lockTitle = "Unlock \(appName)"
    static let lockBody = "Confirm it is you to see the school app."
    static let unlock = "Unlock"

    /* Read out by VoiceOver while the loading screen is up. */
    static let splashLoading = "Loading the school app"
}
