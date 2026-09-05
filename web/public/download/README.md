Files served at https://<host>/download/.

They live in web/public/ rather than being uploaded to the webroot by hand,
because the webroot is synced with `rsync --delete` from two different places
(Makefile deploy-ui and scripts/build-on-server.sh). Anything not produced by
the web build is deleted by whichever one runs next -- which happened three
times to the APK before the cause was found, each time leaving a URL that
answered 200 with the SPA's index.html instead of the file.

Vite copies public/ into dist/ verbatim, so these are part of the build output
and every deploy reproduces them. No --exclude to remember, and it does not
matter which branch the deploy came from.

sms-gateway.apk is the signed release build of mobile/apps/sms-gateway.
Rebuild:  bash mkapk2.sh   (keystore: ~/.local/erp-release/erp-release.jks)
Losing that keystore means every handset needs an uninstall before it can
take another update.

--- August 2026 -------------------------------------------------------------

These are now the *legacy* direct links. The page a school is given is /apps,
which is server-rendered by internal/api/apps.go and reads its builds from
APK_DIR (/var/lib/temperp/apk) with `make publish-apk`.

The move is off the webroot entirely rather than to another corner of it: a
directory outside /var/www cannot be reached by either rsync --delete, which is
the bug this README was written about, and it separates a driver-app release
from a redeploy of the SPA. It also lets the page carry a version, a size, a
build date and a SHA-256, none of which a bare directory listing can.

sms-gateway.apk is kept here and still answers, because it is the URL already
sent to handsets. Nothing new should be added to this directory.

--- September 2026 ---------------------------------------------------------

All three APKs are back here -- parent.apk, bus-tracker.apk, sms-gateway.apk --
because the hosts without a disk need them. On Cloudflare Pages and Cloud Run
there is no APK_DIR: the /apps page (still Go-rendered, still proxied by the
Pages Function -- see web/public/_routes.json and SERVER_PATHS in
web/functions/[[path]].ts) finds no disk build and links these files at
/download/<slug>.apk instead. Pages serves them straight from the edge, nginx
from the webroot, and the Go process itself from WEB_DIST. In that state the
page says the build is a static file and shows no version, size or SHA-256:
those are measured off the disk build and are not invented. /apps/<slug>.apk
with no disk build redirects here rather than 404ing, for any handset that was
given that URL.

On the VPS, `make publish-apk` into APK_DIR still wins: a disk build is what
the card shows, with its version and digest, and these files are ignored. The
file names must stay <slug>.apk to match the catalogue in
internal/api/apps.go.
