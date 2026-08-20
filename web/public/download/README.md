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
