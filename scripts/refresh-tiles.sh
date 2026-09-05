#!/usr/bin/env bash
# Refresh the self-hosted map: one PMTiles archive of the region, cut from the
# latest daily Protomaps build of OpenStreetMap, plus the fonts and sprites the
# basemap style needs. Served by nginx under /tiles/ (see deploy.sh), read by
# web/src/components/FleetMap.tsx.
#
# Runs on the server as root. Safe to re-run: the archive is written aside and
# renamed, so a parent's map never reads a half-written file, and a failed
# download leaves the previous archive in place.
#
#   bash scripts/refresh-tiles.sh            # latest build, default region
#   BBOX=77,8,80.5,13.6 bash refresh-tiles.sh   # a different region
#   TILES_R2=1 R2_BUCKET=temperp bash refresh-tiles.sh   # ...and mirror to R2
#
# Monthly is plenty: roads do not move. The daily builds exist so that a fresh
# extract is always available, not so that we take one every day.
set -euo pipefail

DIR=${TILES_DIR:-/var/www/temperp-tiles}
# Andhra Pradesh + Telangana with margin, lon/lat: west,south,east,north.
BBOX=${BBOX:-76.5,12.4,84.9,20.0}
MAXZOOM=${MAXZOOM:-15}
ARCHIVE="$DIR/south-india.pmtiles"

mkdir -p "$DIR/assets"

if ! command -v pmtiles >/dev/null; then
    V=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
        | grep -oE '"tag_name": *"v[0-9.]+"' | grep -oE '[0-9.]+')
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${V}/go-pmtiles_${V}_Linux_x86_64.tar.gz" \
        | tar xz -C /tmp pmtiles
    install -m 755 /tmp/pmtiles /usr/local/bin/pmtiles && rm -f /tmp/pmtiles
fi

# The build index has moved more than once; probing the dated filenames is
# the one thing that has kept working.
BUILD=""
for d in $(seq 0 14); do
    B=$(date -u -d "-$d day" +%Y%m%d)
    if curl -fsI "https://build.protomaps.com/$B.pmtiles" >/dev/null 2>&1; then BUILD=$B; break; fi
done
[ -n "$BUILD" ] || { echo "no Protomaps daily build found in the last two weeks" >&2; exit 1; }

if [ -f "$DIR/BUILD" ] && [ "$(cat "$DIR/BUILD")" = "$BUILD" ] && [ -s "$ARCHIVE" ]; then
    echo "already on build $BUILD"
else
    echo "extracting build $BUILD for bbox $BBOX up to z$MAXZOOM"
    # Niced: the one core is also serving the school.
    nice -n 15 ionice -c 3 pmtiles extract "https://build.protomaps.com/$BUILD.pmtiles" \
        "$ARCHIVE.tmp" --bbox="$BBOX" --maxzoom="$MAXZOOM"
    mv "$ARCHIVE.tmp" "$ARCHIVE"
    echo "$BUILD" > "$DIR/BUILD"
fi

# Fonts and sprites for the Protomaps basemap style. Small, and rarely change.
if [ ! -d "$DIR/assets/fonts" ] || [ ! -d "$DIR/assets/sprites" ]; then
    curl -fsSL https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.tar.gz \
        | tar xz -C "$DIR/assets" --strip-components=1 basemaps-assets-main/fonts basemaps-assets-main/sprites
fi

chown -R www-data:www-data "$DIR" 2>/dev/null || true
ls -la "$ARCHIVE"
pmtiles show "$ARCHIVE" | grep -iE "tile type|bounds|zoom" || true

# Optional: mirror the archive and assets to R2, for a host with no disk to
# serve /tiles/ from (Cloud Run; see docs/hosting-cloud-run.md). Off unless
# TILES_R2=1, and never required: the nginx copy above is complete on its own.
#
# Needs R2_BUCKET and one of:
#   rclone   with a remote configured for the bucket, named by R2_REMOTE
#            (default "r2"): rclone config, type s3, provider Cloudflare.
#   aws cli  with R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com and
#            AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for an R2 API token.
#
# Objects land under tiles/, so with the bucket's public custom domain
# (R2_PUBLIC_HOST in the Cloud Run manifests) the URLs are
#   https://<R2_PUBLIC_HOST>/tiles/south-india.pmtiles
#   https://<R2_PUBLIC_HOST>/tiles/assets/fonts/<stack>/<range>.pbf
#   https://<R2_PUBLIC_HOST>/tiles/assets/sprites/v4/light.{json,png}
# and the web build takes VITE_TILES_BASE=https://<R2_PUBLIC_HOST>/tiles
# (web/.env.production). R2 answers range requests, which is all PMTiles
# needs; the bucket's CORS rule must allow GET from the site's origin.
if [ "${TILES_R2:-0}" = "1" ]; then
    [ -n "${R2_BUCKET:-}" ] || { echo "TILES_R2=1 but R2_BUCKET is unset" >&2; exit 1; }
    PREFIX=${R2_PREFIX:-tiles}
    if command -v rclone >/dev/null; then
        REMOTE=${R2_REMOTE:-r2}
        echo "mirroring to $REMOTE:$R2_BUCKET/$PREFIX with rclone"
        rclone copyto "$ARCHIVE" "$REMOTE:$R2_BUCKET/$PREFIX/south-india.pmtiles" --s3-no-check-bucket
        rclone copyto "$DIR/BUILD" "$REMOTE:$R2_BUCKET/$PREFIX/BUILD" --s3-no-check-bucket
        rclone copy "$DIR/assets" "$REMOTE:$R2_BUCKET/$PREFIX/assets" --s3-no-check-bucket
    elif command -v aws >/dev/null; then
        [ -n "${R2_ENDPOINT:-}" ] || { echo "TILES_R2=1 with the aws cli needs R2_ENDPOINT" >&2; exit 1; }
        echo "mirroring to s3://$R2_BUCKET/$PREFIX with the aws cli"
        aws --endpoint-url "$R2_ENDPOINT" s3 cp "$ARCHIVE" "s3://$R2_BUCKET/$PREFIX/south-india.pmtiles" \
            --content-type application/octet-stream
        aws --endpoint-url "$R2_ENDPOINT" s3 cp "$DIR/BUILD" "s3://$R2_BUCKET/$PREFIX/BUILD" --content-type text/plain
        aws --endpoint-url "$R2_ENDPOINT" s3 sync "$DIR/assets" "s3://$R2_BUCKET/$PREFIX/assets"
    else
        echo "TILES_R2=1 but neither rclone nor the aws cli is installed" >&2; exit 1
    fi
fi
