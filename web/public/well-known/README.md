# App association files

Two files, one for each shell around the portal:

* `assetlinks.json` -- Android. Turns the parent app's `autoVerify` intent
  filter (mobile/apps/parent/app/src/main/AndroidManifest.xml) from a hopeful
  declaration into a verified one; without it a link in an SMS opens the
  browser unless a parent enables the app by hand in Settings.
* `apple-app-site-association` -- iOS. No extension, by Apple's rule. The
  universal-link half of the same claim, declared in
  mobile/apps/parent-ios/Config/Parent.entitlements.

## Why this directory has no leading dot

Both are looked for under `/.well-known/`, and this directory is `well-known`.
Vite does not copy dot directories out of `public/` into `dist/`, so a file
written at the dotted path was silently dropped from every build and the SPA
fallback answered 200 text/html, which both platforms read as "this host
publishes nothing" rather than as an error. So the files live here and every
server maps the dotted URL onto them, as application/json, with no redirect:

* nginx: the two `location = /.well-known/...` blocks in scripts/deploy.sh
  (and the idempotent inserter in scripts/build-on-server.sh).
* Cloudflare Pages: the two 200 rewrites in `web/public/_redirects` and the
  Content-Type rules in `web/public/_headers`.
* The Go process itself (WEB_DIST, Cloud Run): `wellKnown` in cmd/web/main.go.

## The values

The Android fingerprint is the SHA-256 of the certificate that actually signs
the APKs on the download page -- the release key `bustracker` in
`~/.local/erp-release/bus-tracker-release.jks` on the build box, named by
mobile/apps/parent/keystore.properties. All three apps are signed with it. Read
it off a built APK (no password needed) with

    apksigner verify --print-certs parent.apk | grep SHA-256

or off the keystore with

    keytool -list -v -keystore ~/.local/erp-release/bus-tracker-release.jks \
      -alias bustracker | grep SHA256

A debug build is signed by a different key and its links will not verify;
add `~/.android/debug.keystore`'s fingerprint to the array while installing
debug builds on team phones, and take it out again.

The iOS entry is `<TEAMID>.com.schoolerp.parent`. `TEAMID` is a placeholder
until the Apple Developer team id is known (Xcode, Signing & Capabilities, or
developer.apple.com > Membership). It is an account detail, so it is not in
Config/Portal.xcconfig either.

Neither file names the host: they stay valid on a new domain as long as the
apps are built with that domain as `portalUrl` / `PORTAL_HOST`.

## Checking it, after a deploy

    curl -sSI https://<host>/.well-known/assetlinks.json
    curl -sSI https://<host>/.well-known/apple-app-site-association

Both must be 200, `content-type: application/json`, on https, with no
redirect; the body must not be the SPA's index.html. Android fetches at
install time and does not retry often, so a file that was missing when the
app was installed stays unverified until the app is reinstalled (or
`adb shell pm verify-app-links --re-verify com.schoolerp.parent`). Apple
fetches through its CDN: https://app-site-association.cdn-apple.com/a/v1/<host>
