#!/usr/bin/env bash
# Build the signed release bundle for Google Play.
#
#   bash playstore/build/build-aab.sh                    # portal = production
#   PORTAL_URL=https://staging.example.com bash playstore/build/build-aab.sh
#
# Needs: JDK 17, Android SDK (ANDROID_HOME or local.properties), and
#   mobile/apps/parent/keystore.properties        (see KEYSTORE.md)
#   mobile/apps/parent/app/google-services.json   (Firebase; optional but wanted)
# Output: playstore/out/app-release.aab  (+ a universal APK for a smoke test)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/mobile/apps/parent"
OUT="$ROOT/playstore/out"
PORTAL_URL="${PORTAL_URL:-https://school-erp-cqj.pages.dev}"

[ -f "$APP/keystore.properties" ] || { echo "missing $APP/keystore.properties -- see playstore/build/KEYSTORE.md" >&2; exit 1; }
[ -f "$APP/app/google-services.json" ] || echo "WARNING: no google-services.json -- the bundle will build but push notifications will not work" >&2
command -v java >/dev/null || { echo "java not found: install JDK 17" >&2; exit 1; }

# versionCode must rise on every Play upload. Read the current one so the
# operator sees it; bump it in app/build.gradle.kts before a re-upload.
VC=$(grep -oE 'versionCode *= *[0-9]+' "$APP/app/build.gradle.kts" | grep -oE '[0-9]+$')
VN=$(grep -oE 'versionName *= *"[^"]+"' "$APP/app/build.gradle.kts" | cut -d'"' -f2)
echo "=== WISEN parent app  versionName=$VN versionCode=$VC  portal=$PORTAL_URL ==="

cd "$APP"
./gradlew --no-daemon clean bundleRelease -PportalUrl="$PORTAL_URL"

mkdir -p "$OUT"
cp app/build/outputs/bundle/release/app-release.aab "$OUT/app-release.aab"
echo "AAB: $OUT/app-release.aab ($(du -h "$OUT/app-release.aab" | cut -f1))"

# Smoke test: a universal APK from the bundle, installable with adb. bundletool
# is a ~20 MB jar from https://github.com/google/bundletool/releases.
if [ -n "${BUNDLETOOL:-}" ] && [ -f "$BUNDLETOOL" ]; then
  # shellcheck disable=SC1090
  set -a; . "$APP/keystore.properties"; set +a
  java -jar "$BUNDLETOOL" build-apks --bundle="$OUT/app-release.aab" --output="$OUT/app-release.apks" \
    --mode=universal --overwrite \
    --ks="$storeFile" --ks-key-alias="$keyAlias" --ks-pass="pass:$storePassword" --key-pass="pass:$keyPassword"
  (cd "$OUT" && unzip -o -q app-release.apks universal.apk && mv universal.apk app-release-universal.apk)
  echo "Universal APK for a device test: $OUT/app-release-universal.apk  (adb install -r ...)"
fi

echo
echo "Next: Play Console -> Testing -> Closed testing -> upload $OUT/app-release.aab"
echo "Then bump versionCode in app/build.gradle.kts before the next upload."
