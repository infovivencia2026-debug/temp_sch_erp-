#!/usr/bin/env bash
# Build the three binaries on the server itself, from a git checkout there.
#
# The original deploy cross-compiled on the operator's machine and uploaded
# 50MB of binaries, because this box was described as having "1 vCPU and a
# nearly full disk". Half of that is no longer true — it has 32GB free — and
# the half that is true (one core) costs a few minutes on a cold build and
# almost nothing afterwards, because Go's build cache persists between runs.
#
# What this buys: the machine that deploys no longer needs a Go toolchain, and
# what runs in production is built from a commit hash you can name rather than
# from whatever happened to be in someone's working tree.
#
# Idempotent. Run as root on the server, or via `make deploy-server`.
#
#   BRANCH=operational-erp bash build-on-server.sh
set -euo pipefail

REPO=${REPO:-https://github.com/infovivencia2026-debug/temp_sch_erp-.git}
BRANCH=${BRANCH:-operational-erp}
SRC=${SRC:-/opt/temperp-src}
APP_DIR=${APP_DIR:-/opt/temperp}
WEBROOT=${WEBROOT:-/var/www/temperp}
SERVICE=${SERVICE:-temperp}
ENV_FILE=${ENV_FILE:-/etc/temperp.env}

export PATH=$PATH:/usr/local/go/bin
export GOFLAGS=-mod=mod

say() { printf '\n=== %s ===\n' "$1"; }

say "Toolchain"
go version

say "Source: $BRANCH"
if [ -d "$SRC/.git" ]; then
    # Hard reset, not checkout. The build writes into the tree -- vite
    # regenerates web/tsconfig.tsbuildinfo, which is tracked -- so the second
    # deploy found local changes and refused to move. A deploy checkout is
    # disposable by definition; anything uncommitted in it is build output.
    git -C "$SRC" fetch --quiet origin "$BRANCH"
    git -C "$SRC" reset --quiet --hard "origin/$BRANCH"
    git -C "$SRC" clean -qfd -e node_modules -e web/node_modules
else
    rm -rf "$SRC"
    git clone --quiet --branch "$BRANCH" "$REPO" "$SRC"
fi
COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
echo "at $COMMIT — $(git -C "$SRC" log -1 --format=%s)"

say "Build"
cd "$SRC"
# One core: -p 1 keeps the compiler from thrashing, and the build cache under
# /root/.cache/go-build makes every run after the first one quick.
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o /tmp/build-web ./cmd/web
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o /tmp/build-worker ./cmd/worker
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o /tmp/build-migrate ./cmd/migrate
ls -lh /tmp/build-web /tmp/build-worker /tmp/build-migrate | awk '{print $5, $9}'

say "Build SPA"
# Built here too, so a deploy needs nothing on the operator's machine but ssh.
# npm ci rather than install: the lockfile is what was tested.
cd "$SRC/web"
npm ci --silent --no-audit --no-fund
npm run build
du -sh dist

say "Migrate"
# Migrations run BEFORE the new binaries are installed and the services
# restarted. If a migration fails the old binaries are still serving, which is
# the difference between a failed deploy and an outage.
install -o root -g root -m 0755 /tmp/build-migrate "$APP_DIR/migrate.new"
( set -a; . "$ENV_FILE"; set +a; "$APP_DIR/migrate.new" up )
( set -a; . "$ENV_FILE"; set +a; "$APP_DIR/migrate.new" seed )

say "Install and restart"
mv "$APP_DIR/migrate.new" "$APP_DIR/migrate"
install -o root -g root -m 0755 /tmp/build-web    "$APP_DIR/web"
install -o root -g root -m 0755 /tmp/build-worker "$APP_DIR/worker"
rm -f /tmp/build-web /tmp/build-worker /tmp/build-migrate
mkdir -p "$WEBROOT"
rsync -a --delete "$SRC/web/dist/" "$WEBROOT/"
systemctl restart "${SERVICE}-web" "${SERVICE}-worker"
sleep 2
systemctl is-active "${SERVICE}-web" "${SERVICE}-worker"

say "Deployed $COMMIT"
