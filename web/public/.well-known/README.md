# Digital asset links

`assetlinks.json` is what turns the parent app's `autoVerify` intent filter from
a hopeful declaration into a verified one. Without it Android does not believe
the app when it claims this host, and a link in an SMS or an email opens the
browser unless a parent goes into Settings and enables it by hand. Almost none
will.

## The fingerprint here is the DEBUG signing certificate

This installation has no release keystore, so the APKs on the download page are
debug-signed and this is the certificate that actually signs them. It is the
correct value today and it will be the wrong one the moment a release build is
produced, because the fingerprint is of the key, not of the app. A release build
whose links have quietly stopped opening is a hard thing to diagnose from the
symptom, so: when a release keystore exists, add its fingerprint to the array.
Both may be listed at once, which is the usual arrangement while a team still
installs debug builds on their own phones.

Read the current one with:

    keytool -list -v -keystore ~/.android/debug.keystore \
      -alias androiddebugkey -storepass android -keypass android | grep SHA256

## Checking it

    curl -s https://<host>/.well-known/assetlinks.json

It must come back as application/json, on https, with no redirect. Android
fetches it at install time and does not retry often, so a file that was missing
when the app was installed stays unverified until the app is reinstalled.
