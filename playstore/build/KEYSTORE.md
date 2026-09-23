# Signing: create the upload key (one time) and where it goes

Google Play uses **Play App Signing** for every new app: you sign the bundle with an
**upload key**; Google verifies it and re-signs the app with the **app signing key** it
holds. If you ever lose the upload key, Google can reset it — so the upload key is the
right thing to generate fresh here, on the build machine.

> **Never commit** `keystore.properties`, `*.jks` or `google-services.json`. They are
> git-ignored (see `.gitignore`). Keep the keystore and its passwords in your password
> manager and a second offline copy.

## 1. Generate the upload keystore (needs JDK 17 — the same one Android Studio/Gradle use)

Linux / macOS / Git Bash:
```bash
mkdir -p ~/.local/erp-release
keytool -genkeypair -v \
  -keystore ~/.local/erp-release/educloud-upload.jks \
  -alias educloud-upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=WISEN, O=[OPERATOR LEGAL NAME], L=[CITY], ST=[STATE], C=IN"
```
Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.local\erp-release" | Out-Null
keytool -genkeypair -v -keystore "$env:USERPROFILE\.local\erp-release\educloud-upload.jks" -alias educloud-upload -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=WISEN, O=[OPERATOR LEGAL NAME], L=[CITY], ST=[STATE], C=IN"
```
Choose a long store password; use the same for the key password (Android's PKCS12 default requires it).

## 2. Tell Gradle about it
Copy `keystore.properties.example` to **`mobile/apps/parent/keystore.properties`** and fill it in:
```
storeFile=/home/you/.local/erp-release/educloud-upload.jks     # absolute path (Windows: C:/Users/you/.local/erp-release/educloud-upload.jks)
storePassword=...
keyAlias=educloud-upload
keyPassword=...
```
`app/build.gradle.kts` reads this file and wires `signingConfigs.release` when it exists.

## 3. Firebase (push notifications)
Download `google-services.json` for the Android app `com.schoolerp.parent` from the Firebase
console → Project settings → Your apps, and place it at **`mobile/apps/parent/app/google-services.json`**.
Without it the app still builds, but push is dead while the manifest still declares
`POST_NOTIFICATIONS` — a reviewer may flag a permission with no working feature.

## 4. Existing key — read this if you already sideload the app
The sideloaded APKs on the school website are signed with an older release key
(fingerprint published in `web/public/well-known/assetlinks.json`, keystore described in
`web/public/well-known/README.md`). Two consequences:
- **Play and sideload builds are different certificates.** A phone with the sideloaded
  APK cannot update in place to the Play version; it must uninstall first. Tell schools.
  (Alternative: upload the *existing* release key to Play as the upload key via Play
  Console → App signing → "Use a different key"; then no reinstall is needed. Only do
  this if you have that keystore and its password.)
- After enrolling in Play App Signing, add Google's **app signing certificate SHA-256**
  (Play Console → Setup → App signing) to `assetlinks.json` alongside the old one, so
  deep links verify for both installs.

## 5. Get the fingerprints (for assetlinks.json / Firebase)
```bash
keytool -list -v -keystore ~/.local/erp-release/educloud-upload.jks -alias educloud-upload | grep SHA256
```
