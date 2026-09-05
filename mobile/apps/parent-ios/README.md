# EDU CLOUD — parent app for iPhone

The iOS sibling of [`mobile/apps/parent`](../parent), the Android parent app.
Same product, same shape: a shell around the school's own portal, and
deliberately nothing more. No login of its own, no copy of any screen, no
state to fall out of step with the server. A fix shipped to the site this
afternoon reaches every installed app without anybody updating anything.

SwiftUI draws the frame; a single `WKWebView` draws the page. There are no
dependencies, for the reason the Android `build.gradle.kts` gives: if this app
needed one, it would be doing something, and it should not be.

## What the shell does itself

Each of these is here because leaving it out is a complaint, and each has a
direct counterpart in the Android `MainActivity` with the same wording.

| Concern | Where |
|---|---|
| Loading screen with the school's mark, over the dimmed last screen the parent saw, handed over from the launch screen on the page's own colour | `Views/SplashView.swift`, `Shell/LastScreen.swift`, `UILaunchScreen` in `Config/Info.plist` |
| Three different failures — wifi off, school unreachable, server 5xx — say three different things; cache is tried before the panel; the network coming back retries by itself | `Shell/WebShell.swift` (`Failure`, `failed`, `networkReturned`), `Shell/NetworkWatch.swift` |
| A page that is still readable gets a banner rather than being replaced | `showBanner`, `Views/BannerView.swift` |
| Pull to refresh that only fires when the *page* says its scroller is at the top | `Shell/PullToRefresh.swift`, `setAtTop` over the bridge |
| The `window.ErpShell` bridge the site already speaks: `setAtTop`, `setAppLock`, `appLockEnabled`, `biometricsAvailable`, `haptic` | `Shell/BridgeScript.swift`, `WebShell.receive` |
| App lock behind Face ID / Touch ID / passcode after a minute away; no snapshot kept while it is on | `Shell/AppLock.swift`, `Views/LockView.swift` |
| Attachments download into Files › EDU CLOUD with the session cookie; non-renderable inline documents open in Quick Look | `Shell/Downloads.swift`, `Shell/ContentDisposition.swift` |
| Anything not the school opens in Safari; a link from another app must name the portal host and one of `/`, `/account`, `/go/` | `decidePolicyFor`, `Shell/DeepLink.swift`, `Config/Parent.entitlements` |
| `alert` / `confirm` / `prompt`, which a bare `WKWebView` silently drops | `Shell/Presenter.swift` |
| Renderer killed under memory pressure → same URL again | `webViewWebContentProcessDidTerminate` |

Things the platform gives for free here that Android had to build: the file
input (WKWebView offers Photo Library / Take Photo / Choose File on its own,
given the two usage strings in `Info.plist`), inline PDF rendering, dark mode
following the phone, back gestures through the page's history, and downloads
carrying the login cookie.

## Building

Xcode 16 or newer (the project uses file-system-synchronised groups, so a
new Swift file dropped into `ParentApp/` is in the build without touching the
project). Deployment target iOS 16.

```
open ParentApp.xcodeproj
```

Set the team under Signing & Capabilities, or in `Config/Portal.xcconfig`
(`DEVELOPMENT_TEAM`), and build. The portal address is `PORTAL_URL` in that
same file; Info.plist, the universal-link entitlement and the Swift code all
read it from there, so the web view, the foreign-host filter and the deep-link
claim cannot disagree.

The one piece with no UIKit in it can be exercised on a Mac with only the
command line tools:

```
swiftc -o /tmp/cd ParentApp/Shell/ContentDisposition.swift <a main.swift calling it>
```

## Shipping

Not the `/apps` sideload page: iOS has no sideloading, so this goes through
TestFlight and the App Store, and the Makefile's `publish-apk` does not apply.
Version and build number are `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`
in `Config/Portal.xcconfig`.

## Server side, still to do

Universal links are inert until the portal serves
`/.well-known/apple-app-site-association` naming `<TEAMID>.com.schoolerp.parent`
with the same three path patterns. Until then a link in an SMS opens Safari,
which is the correct failure — an unverified claim on somebody else's links
should not be honoured. The Android app is in the same position with
`assetlinks.json`; both files belong in the same server change.

## Not verified on a device

This tree was written before Xcode was on the machine, and the first build
against the iOS SDK is still to happen (Xcode 26.6 is installed but its
licence has not been accepted; `sudo xcodebuild -license accept`). Every file
parses, `ContentDisposition` runs and passes its checks, the
plists lint, and nothing here has been compiled against the iOS SDK or run on
a phone. The first build will say whether any delegate signature drifted; the
first run will say whether the pull gesture and the splash handover feel
right. Read the Android app's commit history for what those two took to get
right there.
