# The apps: Android, iPhone, Windows, Linux — packages, offline, updates

Written 2026-09-26. This is the answer to five questions asked together:
best-performing native apps on each platform, as much data offline as
possible, updates that do not need a reinstall, store-ready packages, and
what to add so the next year of maintenance is cheap.

## 1. What the apps are, and why that is the fast option

All four are **thin native shells around the one web portal**. Each shell is
native code that owns the frame (splash, offline panel, back gesture, push,
biometrics, file pickers, print, downloads) and hands the screen to the
platform's own web engine. There is no second implementation of any screen.

| Platform | Shell | Engine | Source |
|---|---|---|---|
| Android | Kotlin, no dependencies | System WebView (Chromium) | `mobile/apps/parent` |
| iPhone | SwiftUI, no dependencies | WKWebView (Safari engine) | `mobile/apps/parent-ios` |
| Windows | Electron 44 | Bundled Chromium | `desktop` |
| Linux | Electron 44 | Bundled Chromium | `desktop` |

This is the best-performing shape for this product, not a compromise:

- **Cold start** is the shell's splash over the last screen the person saw,
  then the app shell from the service worker's cache. No network round trip
  is needed to paint a real screen (see §2).
- **Warm start** paints the last-seen data instantly from the persisted
  query cache and refetches in the background, which is what a native app
  does and what a parent sees as "not a web page".
- **Bundle discipline** keeps the boot path small: the entry, React, router,
  query and icon chunks are precached; feature chunks, the 1.1 MB map engine
  and fonts load on first use only (`web/vite.config.ts`, `manualChunks`).
- **Old, cheap tablets** get a transpiled bundle with polyfills, so a
  WebView 61 device runs the same build without a separate app.

A fully native rewrite (Compose, SwiftUI screens, WinUI) would buy scroll
smoothness on 300+ row lists and nothing else, at the cost of four codebases
that drift. If that is ever wanted, the place to start is the register and
the fee ledger, not the whole product.

## 2. Offline: what is on the device today

Everything below is already built and shipping through the site. The shells
inherit it because they render the site.

| Layer | What it keeps | Where |
|---|---|---|
| Service worker, shell cache | index.html, stylesheet, boot chunks; every feature chunk after first use | `web/src/sw-src.js`, `SHELL` |
| Service worker, data cache | Every `/api/` GET answer, network-first with a 3.5 s clock, then cached copy marked `X-From-Cache`; 800 entries, 14 days | `sw-src.js`, `DATA` |
| Query persistence | A parent's last-seen answers in localStorage, restored before first paint; 3 days, 2.5 MB cap | `web/src/lib/query-persist.ts` |
| Pre-warming | On sign-in, while idle and online: the chunks of every screen on this person's menu, and for a family the children, attendance, fees and wallet queries | `web/src/lib/offline-warm.ts` |
| Outbox | Writes that got no response are queued with an `Idempotency-Key` and replayed when the network returns; the server replays the stored answer, so nothing runs twice | `web/src/lib/outbox.ts`, `internal/api/idempotency.go` |
| Privacy | Data cache and persisted queries are dropped on sign-out, on a different person signing in, and never written for staff roles on a shared machine | `web/src/lib/sw-data.ts`, `query-persist.ts` |
| Map tiles | Self-hosted PMTiles, served with a one-week cache | `web/public/_headers` |

**Net effect on database reads:** a screen that was opened before is answered
from the device, and only revalidated when it is stale (5 min for most
queries, longer for rosters). A parent opening Fees, Attendance and the bus
screen three times a day generates roughly one server read per screen per
five minutes rather than one per open.

### Where offline can still go further

These are the gaps, in the order they pay back. None is started.

1. **Staff persistence on personal devices.** Query persistence is
   parent-only because staffroom laptops are shared. A teacher's own phone is
   not. Add a "this is my own device" switch under Settings that turns on
   persistence for staff, keyed to the user id as it is for parents.
2. **Bulk snapshot endpoints.** The register and timetable are fetched per
   class per day. One `/api/v1/me/snapshot` returning everything on this
   person's menu for today would let the pre-warm fill the cache in one
   round trip instead of forty.
3. **Stale-while-revalidate for slow-changing reads.** The catalog, rosters
   and settings could be cache-first with a background revalidate, saving
   the 3.5 s wait on a dead line entirely for those reads.
4. **Outbox visibility.** A count of queued writes in the header, and a
   screen listing them, so a clerk knows what has not yet reached the server.
5. **Background sync.** Register the outbox with the Background Sync API so
   queued writes go out even when the app is not in the foreground
   (Android/Chromium only; iOS does not support it).

## 3. Updates without a reinstall

This is already the whole design. The shells contain no screens, so **every
web deploy updates every installed app** on the next open:

- The service worker installs the new build in the background and takes over
  when the page says it is safe (`erp-take-over`), never mid-task.
- Cached data survives a deploy; only the shell cache is replaced.
- The old VPS hostname is compiled into every shell as an alias, so the move
  to Cloud Run and Pages did not strand any installed copy.

The shell itself changes only when the native frame changes (a new bridge
call, a new permission, a new Electron). That is a store release, expected a
few times a year. To make even that rare case painless, see §5 item 1.

## 4. Packages, and how each is uploaded

All artefacts from this build are in `dist/apps-2026-09-26/` (git-ignored),
with `SHA256SUMS.txt`.

### Google Play (Android)

- Package: `android/WISEN-1.0.0-playstore.aab`, signed with the upload key
  (`~/.local/erp-release/wisen-upload.jks`, alias `wisen-upload`,
  password in the password manager). Signature blocks present (`WISEN-UP.RSA`).
- Full submission kit, listing copy and every policy-form answer:
  `playstore/README.md` and `playstore/HANDOFF.md`.
- Upload: Play Console → Create app → Production (or Closed testing) →
  Create release → drop the `.aab`.
- **Still blocking, operator only:** phone screenshots, a reviewer demo
  parent login, and the `[PLACEHOLDER]` fields in the public privacy, terms
  and delete-account pages. A personal developer account also needs 20
  testers for 14 days before production.
- Rebuild: `playstore/build/build-aab.sh` (Gradle fetches its own JDK).

### App Store (iPhone)

- The app compiled for the first time today, both simulator and device
  (`generic/platform=iOS`, Release). The unsigned archive is in
  `ios/WISEN-unsigned.xcarchive` as proof of build; App Store Connect needs a
  signed one, which needs the team id.
- Portal host was corrected to the Pages site with the old VPS host as an
  alias (`Config/Portal.xcconfig`, `PORTAL_ALIASES`).
- Produce the `.ipa` once the Apple Developer team exists:

```
cd mobile/apps/parent-ios
xcodebuild -scheme ParentApp -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/WISEN.xcarchive \
  DEVELOPMENT_TEAM=<TEAMID> -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/WISEN.xcarchive \
  -exportOptionsPlist Config/ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
xcrun altool --upload-app -f build/export/ParentApp.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

- Then in App Store Connect: TestFlight first, then the listing. Reuse the
  Play listing copy and the same reviewer login. Universal links need
  `<TEAMID>` filled in `web/public/well-known/apple-app-site-association`.

### Microsoft Store (Windows)

- The store package is the AppX/MSIX target, now configured in
  `desktop/package.json` (`build.appx`). It **cannot be built on a Mac**:
  electron-builder needs Windows, or `wine` plus `pwsh`. Build it on the
  Windows build box:

```
cd desktop
npm install
npm run dist:store        # → dist/EDU CLOUD-1.0.0-store-x64.appx
```

- Before the first store build, replace the three identity values in
  `build.appx` with the ones Partner Center shows under
  Product → Product identity: `identityName`, `publisher` (the `CN=…` GUID),
  `publisherDisplayName`. The store re-signs the package, so no certificate
  is needed locally.
- Upload: Partner Center → the app → Packages → drop the `.appx`. The store
  then handles updates for installed copies.
- Also built here for direct distribution (pen drive, school website):
  `windows/EDU CLOUD-Setup-1.0.0-x64.exe` (installer, per-user, no admin),
  the arm64 installer, and the portable zip. These are unsigned, so
  SmartScreen will warn until an Authenticode certificate is bought.

### Linux

- `linux/EDU CLOUD-1.0.0.AppImage` (x64) and the arm64 one: `chmod +x` and
  run. `edu-cloud-desktop-1.0.0.tar.gz` for a packaged install.
- No store. If a distro package is ever wanted, `electron-builder --linux
  deb rpm` produces both from the same config.

## 5. What to add for cheap maintenance and easy updates

In priority order. Each is small and each removes a class of support call.

1. **Shell version floor, served by the site.** Every shell already reports
   itself through `window.ErpShell`. Serve `/app/shell-versions.json` with
   the minimum shell version per platform; the page compares and shows a
   one-line "update the app from the store" banner when below it. Today
   there is no way to tell an old shell it is old.
2. **One version source.** `versionName`, `MARKETING_VERSION` and the
   desktop `version` are three files edited by hand. A `scripts/bump-apps.sh
   1.1.0` that rewrites all three and tags the commit stops them drifting.
3. **CI builds for every shell.** A GitHub Actions matrix: Gradle on
   ubuntu, xcodebuild on macos, electron-builder on ubuntu (Linux + NSIS)
   and windows (AppX). Artefacts attached to the tag. Signing secrets in the
   repository secrets. Then a release is a tag push, not an afternoon.
4. **Fastlane, or the two `upload` CLIs.** `fastlane supply` for Play and
   `altool` / `fastlane deliver` for App Store turn the console walkthroughs
   into one command each, and take the store metadata from `playstore/`.
5. **Play App Signing fingerprint in `assetlinks.json`.** Do this the day
   the Play listing goes live, or deep links from SMS open the browser.
6. **Firebase config for push.** `google-services.json` is missing, so
   Android push is dead and the manifest declares a permission it does not
   use. Either add the file or drop the permission before review.
7. **Remote configuration endpoint.** A tiny `/api/v1/client-config` (feature
   flags, banner text, support phone, maintenance window) read by the page
   at boot lets you change behaviour without a deploy of anything.
8. **Crash and error reporting from the shells.** The page already logs;
   the native frames do not. A `window.onerror` relay plus a
   `render-process-gone` counter to the same endpoint tells you which
   WebView versions are failing before a school does.
9. **Electron auto-update for the non-store builds.** The store handles
   Windows; the pen-drive installer and Linux AppImage do not update. If
   those become common, `electron-updater` against a static
   `latest.yml` on Pages is a day of work. Deliberately not done now: the
   desktop README argues why, and the argument holds while the shell is
   stable.
10. **A `make release-apps` target** that runs the bump, the builds that
    can run here, checksums, and writes this folder layout, so the next
    release is reproducible from one line.
