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
#   BRANCH=main bash build-on-server.sh
set -euo pipefail

# One deploy at a time.
#
# Two overlapping runs used to destroy each other: the install step finished
# with `rm -f /tmp/build-*`, a fixed path shared by every run, so a deploy that
# was still going lost its binaries to the cleanup of one that had just
# finished. It looked like a flaky /tmp and was two deploys in the same
# minute -- easy to cause, because piping the output through `tail` closes the
# local pipe while the remote script carries on.
#
# flock rather than a pidfile: the kernel releases it if this shell dies, so a
# killed deploy cannot leave a lock nobody can clear.
exec 9>/var/lock/temperp-deploy.lock
if ! flock -n 9; then
    echo "another deploy is already running on this host; waiting for it" >&2
    flock 9
fi

# This run's own build directory, removed on the way out however we leave.
# Nothing here is shared with a concurrent run any more, so the lock above is
# belt and the mktemp is braces.
BUILD=$(mktemp -d /tmp/temperp-build.XXXXXXXX)
trap 'rm -rf "$BUILD"' EXIT

REPO=${REPO:-https://github.com/infovivencia2026-debug/temp_sch_erp-.git}
# main is the only branch anybody maintains. The default used to be
# operational-erp, which meant a deploy run without BRANCH set shipped a branch
# nobody had committed to in weeks — and reported success doing it.
BRANCH=${BRANCH:-main}
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
# COMMIT pins the deploy to an exact revision. Without it a deploy means
# "whatever origin/$BRANCH pointed at the moment this ran", which is not a
# thing you can redeploy: two runs a minute apart can ship different code and
# both report the same branch name. With it, rolling back is the same command
# with the previous hash, and the hash is what gets stamped into the binary,
# printed at the end, and recorded against any queue repair done afterwards.
if [ -n "${COMMIT:-}" ]; then
    git -C "$SRC" fetch --quiet origin "$COMMIT" 2>/dev/null || true
    git -C "$SRC" rev-parse --verify --quiet "${COMMIT}^{commit}" >/dev/null \
        || { echo "commit $COMMIT is not in $SRC after fetching $BRANCH" >&2; exit 1; }
    git -C "$SRC" reset --quiet --hard "$COMMIT"
fi
COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
echo "at $COMMIT — $(git -C "$SRC" log -1 --format=%s)"

# Refuse to ship a commit that is not on the branch, unless asked. A detached
# hash from a dead branch installs just as happily as a good one, and the next
# deploy from $BRANCH silently reverts it -- which reads as "my fix disappeared
# in production" rather than as the deploy that never should have happened.
if [ "${ALLOW_OFF_BRANCH:-0}" != "1" ] \
   && ! git -C "$SRC" merge-base --is-ancestor HEAD "origin/$BRANCH" 2>/dev/null; then
    echo "HEAD ($COMMIT) is not an ancestor of origin/$BRANCH — refusing." >&2
    echo "Push it to $BRANCH first, or re-run with ALLOW_OFF_BRANCH=1." >&2
    exit 1
fi

say "Build"
cd "$SRC"
# One core: -p 1 keeps the compiler from thrashing, and the build cache under
# /root/.cache/go-build makes every run after the first one quick.
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o "$BUILD/web" ./cmd/web
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o "$BUILD/worker" ./cmd/worker
CGO_ENABLED=0 go build -p 1 -trimpath -ldflags "-s -w -X main.version=$COMMIT" \
    -o "$BUILD/migrate" ./cmd/migrate
for b in web worker migrate; do
    [ -s "$BUILD/$b" ] || { echo "build produced no $b binary — aborting before anything is installed" >&2; exit 1; }
done
ls -lh "$BUILD/web" "$BUILD/worker" "$BUILD/migrate" | awk '{print $5, $9}'

say "Build SPA"
# Built here too, so a deploy needs nothing on the operator's machine but ssh.
# npm ci rather than install: the lockfile is what was tested.
cd "$SRC/web"
# Not --silent: an npm ci that dies half way leaves node_modules
# gutted, and the next thing to fail is `tsc: not found` several
# steps later, which sends you looking in the wrong place.
npm ci --no-audit --no-fund
# npm ci can exit 0 having left the tree half-built — a package directory
# present but its bin symlink never created. That happened after two deploys
# raced and one died on ETXTBSY: `npm ci` afterwards reported "added 187
# packages" and success, and the failure surfaced several steps later as
# `sh: 1: vite: not found`, which sends you looking at PATH and NODE_ENV
# rather than at node_modules. Check the toolchain is actually runnable.
for tool in vite tsc; do
    [ -x "node_modules/.bin/$tool" ] || {
        echo "npm ci finished but node_modules/.bin/$tool is missing — the tree is" >&2
        echo "half-installed. Fix: rm -rf $SRC/web/node_modules and deploy again." >&2
        exit 1
    }
done
npm run build
du -sh dist

say "Migrate"
# Migrations run BEFORE the new binaries are installed and the services
# restarted. If a migration fails the old binaries are still serving, which is
# the difference between a failed deploy and an outage.
install -o root -g root -m 0755 "$BUILD/migrate" "$APP_DIR/migrate.new"
( set -a; . "$ENV_FILE"; set +a; "$APP_DIR/migrate.new" up )
( set -a; . "$ENV_FILE"; set +a; "$APP_DIR/migrate.new" seed )

say "Install and restart"
mv "$APP_DIR/migrate.new" "$APP_DIR/migrate"
install -o root -g root -m 0755 "$BUILD/web"    "$APP_DIR/web"
install -o root -g root -m 0755 "$BUILD/worker" "$APP_DIR/worker"
# the trap removes $BUILD; nothing to clean up by hand
# The API comes up BEFORE the new page is served.
#
# This was the other way round, and the two seconds between them were a real
# fault rather than a theoretical one: the new bundle was already being served
# while the old binary was still answering, so a page loaded in that window
# asked for endpoints that did not exist yet and showed "resource not found".
# Somebody opening the seller dashboard mid-deploy saw exactly that.
#
# Restarting first inverts the overlap into the safe direction. A new API
# serving an old page is fine — releases add endpoints far more often than they
# remove them, and an old page asks only for what already existed. The reverse
# is never fine.
systemctl restart "${SERVICE}-web" "${SERVICE}-worker"

mkdir -p "$WEBROOT"
# --delete keeps the webroot honest: a bundle removed from the build should
# disappear from the server too. /download needs no exception any more -- the
# APK and the SMS test page live in web/public and Vite copies them into dist,
# so they arrive with every build. An --exclude here would now do the opposite
# of what it was added for and keep them OUT.
#
# A tab held open across this loses the chunks it has not fetched yet, which is
# what ChunkBoundary reloads once for -- see web/src/components/ChunkBoundary.
rsync -a --delete "$SRC/web/dist/" "$WEBROOT/"

# ---- the assistant's route, re-asserted on every deploy ---------------------
#
# ragbot.service -- a local RAG assistant, uvicorn in front of ollama -- serves
# the chat tab. It is deployed by hand and is not in this repository, and the
# nginx location that reached it was added by hand too. scripts/deploy.sh
# rewrites the whole server block, so a provisioning run silently removed it:
# the service kept running, unreachable, /assistant/chat fell through to the
# SPA catch-all, and the browser got index.html with a 200 and died on
# JSON.parse. Nothing in the repo mentioned any of it, so reading the repo
# suggested the service did not exist.
#
# Asserted here rather than only in deploy.sh because this is the script a
# deploy actually runs. Idempotent: present is left alone, absent is inserted,
# and a config nginx rejects is rolled back rather than reloaded.
ASSISTANT_PORT="${ASSISTANT_PORT:-8001}"
NGINX_SITE="/etc/nginx/sites-available/${SERVICE}"
if [ -f "$NGINX_SITE" ] && ! grep -q "location /assistant/" "$NGINX_SITE"; then
    say "Assistant route"
    cp "$NGINX_SITE" "${NGINX_SITE}.bak.$(date +%s)"
    ASSISTANT_PORT="$ASSISTANT_PORT" python3 - "$NGINX_SITE" <<'PYEOF'
import os, sys
path = sys.argv[1]
conf = open(path).read()
anchor = "    # ---- SPA"
if anchor not in conf:
    sys.exit("no SPA anchor in the nginx site; leaving it alone")
block = """    # ---- Assistant --------------------------------------------------------
    # ragbot.service (uvicorn + ollama). Trailing slash strips the prefix: the
    # service serves /chat and answers 404 on /assistant/chat. 300s because a
    # small model on one vCPU takes about a minute over a paragraph.
    location /assistant/ {
        proxy_pass http://127.0.0.1:%s/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id      $request_id;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

""" % os.environ["ASSISTANT_PORT"]
open(path, "w").write(conf.replace(anchor, block + anchor, 1))
print("  inserted /assistant/ -> 127.0.0.1:" + os.environ["ASSISTANT_PORT"])
PYEOF
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx
        echo "  nginx reloaded"
    else
        echo "  !! nginx rejected the config; restoring and leaving it unrouted" >&2
        cp "$(ls -t ${NGINX_SITE}.bak.* | head -1)" "$NGINX_SITE"
    fi
fi
sleep 2
systemctl is-active "${SERVICE}-web" "${SERVICE}-worker"

say "Queue"
# A deploy restarts the worker, and restarting the worker orphans whatever it
# was running: those tasks stay in asynq's `active` list with an expired lease,
# where nothing picks them up again. The old deploy ended one line above this
# and called that success -- both units active, queue quietly holding a report
# card run that will never finish.
#
# So the deploy owns the queue it disturbed: requeue what the restart stranded,
# then report the rest. The unstick is fatal if it fails (it is repairing this
# deploy's own damage); the health verdict is not, because a backlog that
# predates this deploy is not a reason to leave the new binaries uninstalled --
# they are already running by now. It is printed loudly instead.
QUEUE_MAINT="$SRC/scripts/queue-maint.sh"
if [ -x "$QUEUE_MAINT" ] || [ -f "$QUEUE_MAINT" ]; then
    SERVICE="$SERVICE" ENV_FILE="$ENV_FILE" SRC="$SRC" YES=1 \
        bash "$QUEUE_MAINT" unstick all --yes
    if ! SERVICE="$SERVICE" ENV_FILE="$ENV_FILE" SRC="$SRC" \
            bash "$QUEUE_MAINT" doctor; then
        echo
        echo "  !! the queue is NOT healthy after this deploy."
        echo "  !! $COMMIT is live; the warnings above are about work already queued."
        echo "  !! read it:    bash $QUEUE_MAINT failed"
        echo "  !! requeue it: bash $QUEUE_MAINT retry all --yes"
        QUEUE_UNHEALTHY=1
    fi
else
    echo "  queue-maint.sh not in this checkout — skipping queue check"
fi

say "Deployed $COMMIT"
[ "${QUEUE_UNHEALTHY:-0}" = "1" ] && echo "(queue needs attention — see above)"
exit 0
