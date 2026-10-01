# EDU CLOUD — the desktop application

The office's copy of the same portal the browser shows, in a window of its
own. Windows and Linux. It is a shell and deliberately nothing more: no login
of its own, no copy of any screen, no state to fall out of step with the
server, so a fix shipped to the site this afternoon reaches every installed
copy without anybody updating anything.

The same argument, and the same answers, as [`mobile/apps/parent`](../mobile/apps/parent)
and [`mobile/apps/parent-ios`](../mobile/apps/parent-ios). This one is aimed at
the desk rather than the pocket: the clerk who collects fees, the principal
who reads the morning board, the HR office running payroll.

## Why it exists at all

The portal is already a web application and both Chrome and Edge will install
it to the desktop from their own menus. What that misses is how a school
distributes software. "Open this link, find the three dots, choose Install" is
a step most offices will not complete; an installer on a pen drive is one they
will. It also takes the address bar off the front of a fee ledger, which is
one fewer place to paste the wrong URL into.

## What the shell does itself

| Concern | Where |
|---|---|
| A loading screen, so the first thing on screen is not an empty rectangle | `src/shell.html`, `show('loading')` |
| Four failures told apart — no network, the school unreachable, the school answering 5xx, a certificate that does not verify — each with what to do next | `failure()` in `src/main.js`, `says` in `src/shell.html` |
| The network coming back retries by itself | the `online` listener in `src/shell.html` |
| Anything that is not the school opens in a real browser | `setWindowOpenHandler`, `will-navigate` |
| Downloads keep the session cookie, and the window says where the file went | `will-download` |
| The renderer being killed under memory pressure reloads rather than leaving a grey window | `render-process-gone` |
| The window's size, position and zoom are remembered | `readState`/`writeState` |
| Print, zoom, reload, full screen | `buildMenu()` |
| The `window.ErpShell` bridge the site already speaks, answered honestly for a machine with no motor and no fingerprint reader | `src/preload.js` |

Search is deliberately absent from the menu: the site's own Ctrl+K searches
screens, children and parents, which is the search anybody in a school
actually wants, and the menu item raises it.

## Building

```
cd desktop
npm install
npm start                 # run it against the compiled-in address
PORTAL_URL=http://localhost:5173 npm start
npm run dist              # Linux AppImage + tar.gz; Windows NSIS installer + zip (+ AppX on Windows)
npm run dist:store        # Windows only: the AppX for the Microsoft Store
```

The address is compiled in, and only `PORTAL_URL` overrides it — the same
decision the bus tracker made the hard way. A field asking a clerk for a
server address is a field they can only get wrong. To build for a different
deployment, change `portal` in `package.json`, or pass it at package time:

```
npx electron-builder --linux --win -c.extraMetadata.portal=https://erp.example.in
```

The Linux targets, the NSIS installer and the zip all cross-build from macOS
or Linux. The AppX for the Microsoft Store does not: electron-builder needs
Windows itself, or wine plus pwsh, so `dist:store` runs on the Windows build
box. Before the first store build, copy the three identity values Partner
Center shows under Product identity into `build.appx` in `package.json`
(`identityName`, `publisher`, `publisherDisplayName`); the store signs the
package itself. The installer and zip are not code-signed, so Windows
SmartScreen shows "unknown publisher" until somebody buys a certificate —
that is the same trade the unsigned APKs already make. Add `--x64 --arm64`
to build both architectures; a bare run builds the host's.

## What it is not

No auto-update: the pages are the product and they update themselves, and a
shell that updates itself is a second deployment channel to keep honest. If
the shell itself ever changes, the school downloads it again, which is the
same cadence as the phone apps. Copies installed from the Microsoft Store are
updated by the store. See `docs/apps-release.md` for the release procedure
across all four platforms.
