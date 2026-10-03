# Native shell contract (`window.ErpShell`)

The Android app (`mobile/apps/parent`), the iOS app (`mobile/apps/parent-ios`)
and the desktop app (`desktop/`) all wrap the same web app. The web app talks
to them through one object, `window.ErpShell`. The TypeScript definition in
`web/src/lib/shell.ts` is the source of truth; this page says how each
platform answers it.

Rules:

- Every member is optional. The web app checks each one (`can('setBadge')`)
  and never branches on the platform name. A browser has none of them.
- Calls into the shell are synchronous and return at once.
- Answers that take time come back as a DOM event named `erp-shell` with
  `detail: { type, ... }` (types below). Android sends it with
  `evaluateJavascript`, iOS with `WKWebView.evaluateJavaScript`, desktop with
  `webContents.executeJavaScript` or a preload `ipcRenderer.on` that dispatches it.
- The bridge is only given to the school's own origin. Any other host opens in
  the system browser.
- `contract` reports the version. Version 2 is everything on this page.

## Calls (page to shell)

| Member | What it does | Android | iOS | Desktop |
|---|---|---|---|---|
| `platform` | `'android'`, `'ios'`, `'desktop'` | yes | yes | yes |
| `setAtTop(v)`, `setGestureLock(on)` | pull-to-refresh gating | yes | yes | no-op |
| `setAppLock(on)`, `appLockEnabled()`, `biometricsAvailable()` | app lock with fingerprint/face | BiometricPrompt | LocalAuthentication | no (false) |
| `haptic(kind)` | the handset's click | Vibrator/HapticFeedback | UIFeedbackGenerator | no-op |
| `print()` | system print sheet | PrintManager | UIPrintInteractionController | `webContents.print()` |
| `pushToken()` | FCM / APNs token or null | FCM | APNs | null |
| `storeKey()` | 32 random bytes, base64, kept in the keystore; seals the offline store | Android Keystore (AES key wraps the stored bytes) | Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) | `safeStorage` |
| `wipe()` | delete the shell's offline files, queued uploads, outbox copy, store key | yes | yes | yes |
| `setBadge(n)` | number on the app icon | notification badge (launchers that support it) | `UNUserNotificationCenter.setBadgeCount` | `app.setBadgeCount` (macOS/Linux Unity), overlay icon on Windows |
| `notify(title, body, href)` | a system notification | not used (server push) | not used (server push) | `Notification` |
| `pickFile(id, kind, accept)` | `kind`: `camera`, `scan`, `file`; answers `picked` | camera intent / ML Kit document scanner / SAF picker | UIImagePicker / VisionKit `VNDocumentCameraViewController` / UIDocumentPicker | `dialog.showOpenDialog` (camera and scan fall back to the file dialog) |
| `openExternal(url)` | open in the browser or owning app | `Intent.ACTION_VIEW` | `UIApplication.open` | `shell.openExternal` |
| `download(id, url, name)` | save an LMS file or video for offline; answers `downloaded` | app-private files dir via WorkManager | background `URLSession` into Application Support | `session.downloadURL` into userData |
| `downloaded(url)` | local address of a saved file, or null | `https://appassets.androidplatform.net/offline/...` via WebViewAssetLoader | `xulo-file://...` via WKURLSchemeHandler | `xulo-file://...` via `protocol.handle` |
| `removeDownload(url)` | delete one saved file | yes | yes | yes |
| `outboxChanged(json)` | the outbox rows waiting to send (see below) | WorkManager job with network constraint | `BGProcessingTask` + background `URLSession` | sent from the main process when the window is hidden |
| `school()`, `switchSchool()` | generic app: the chosen school as `{code,name,host}`; back to the picker | yes | yes | yes |

## Events (shell to page)

```
window.dispatchEvent(new CustomEvent('erp-shell', { detail: {...} }))
```

| `type` | Fields | When |
|---|---|---|
| `picked` | `id`, `files: [{name, type, data(base64)}]` | after `pickFile`; `files` empty when cancelled |
| `share` | `files`, `text?` | another app shared images or PDFs into this one; the page asks where they go (`components/ShareInbox.tsx`) |
| `downloaded` | `id`, `url`, `ok`, `local?` | after `download` |
| `deeplink` | `path` | a link `https://<school host>/...` or `xulo://open/...` opened the app; `path` starts with `/` |
| `connectivity` | `online` | the OS network state changed (more reliable than `navigator.onLine` in a WebView) |
| `push` | `token` | a new push token |

## Offline writes in the background

The outbox lives in the page (`web/src/lib/outbox.ts`). Every time it changes
the page calls `outboxChanged(json)` with the rows still waiting:

```
[{ "id", "key", "method", "path", "body", "queued_at" }]
```

The shell stores that copy and, when the OS gives it network time with the
app closed, sends each row in order with:

- the session cookie from the WebView's cookie store,
- `Idempotency-Key: <key>`,
- `Content-Type: application/json` when there is a body,

to `https://<school host><path>`. It stops at the first row that gets no
answer or a 5xx. It never sends anything else. When the page next opens it
replays the same rows itself; the server recognises each key and answers with
the stored result, so nothing happens twice (`worker/src/idempotency.ts`).

Only paths in `web/src/lib/offline-policy.ts` are ever queued: attendance,
homework, chat, notes and diary, Class Status posts, LMS "I finished this",
leave requests, the person's own settings. Payments, logins and passwords,
publishing results and admissions are never queued; their buttons say
"Needs internet" while offline.

## Deep links

- `https://<school host>/...`: Android App Links (`autoVerify` with
  `/.well-known/assetlinks.json` on the school host), iOS Universal Links
  (`applinks:<host>` entitlement, `/.well-known/apple-app-site-association`),
  desktop: the OS hands the URL to the running instance.
- `xulo://open/<path>`: the custom scheme on all three; opens `<path>` in the
  current school. A per-school build registers `xulo-<slug>://` as well.

## Generic and per-school apps

One app, two configurations (see `docs/white-label.md` and
`scripts/apps/build-school.py`):

- Generic XULO app: no school is fixed. First launch asks for the school code
  (`<country>/<slug>`, for example `in/riverside`), or scans the QR the school
  prints, or opens from a school link. It fetches `/<cc>/<slug>/app.json` for
  the name, logo and colours and remembers it. Settings has Switch school.
- Per-school app: the same code with the school fixed at build time, its name,
  icon and colours baked in. No code differs between schools.

## Adding a capability

1. Add it to `ErpShell` in `web/src/lib/shell.ts` as optional, with a comment.
2. Add a row above.
3. Implement it in each shell, or leave it absent there (never a stub that
   pretends to work).
4. The web feature checks `can('<name>')` and has a browser path.
