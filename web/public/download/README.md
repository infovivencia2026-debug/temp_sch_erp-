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
