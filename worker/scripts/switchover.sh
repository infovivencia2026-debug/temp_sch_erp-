#!/usr/bin/env bash
# Switch the live school ERP from Cloud Run + Neon to the Cloudflare Worker +
# D1. The owner runs this from the repo root, at a quiet hour:
#
#   WORKER_URL=https://school-erp.<account>.workers.dev bash worker/scripts/switchover.sh
#
# Every step stops and asks before it goes on; answering anything but "y"
# ends the script, and it can be re-run from the top (each run loads into
# freshly stamped databases). Runbook: docs/d1-migration.md, "Switchover".
#
# Neon is only ever READ (pg_dump). It stays the source of truth until the
# owner decides otherwise; rollback is reverting API_ORIGIN (step h below).
#
# Works with macOS /bin/bash 3.2.
#
# Environment:
#   WORKER_URL   the Worker's own URL (required; `npx wrangler deployments list` or the dashboard)
#   LIVE_HOST    the live Pages host to post-check (default https://school-erp.pages.dev)
#   LOCAL_PG     a local Postgres server URL to restore into (default postgresql://localhost/postgres)
#   WORK         working directory for the dump and exports (default ~/erp-switchover-<stamp>, outside the repo)
#   USES_PUSH=1  also require FCM_SERVICE_ACCOUNT
set -euo pipefail
cd "$(dirname "$0")/.."            # worker/
export PATH="$HOME/tools/node22/bin:$PATH"
WR="npx wrangler"
STAMP="${STAMP:-$(date +%Y%m%d%H%M)}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORKER_URL="${WORKER_URL:?set WORKER_URL to the Worker URL, e.g. https://school-erp.<account>.workers.dev}"
WORKER_URL="${WORKER_URL%/}"
WORKER_URL="${WORKER_URL:-https://school-erp.infovivencia2026.workers.dev}"
LIVE_HOST="${LIVE_HOST:-https://school-erp-cqj.pages.dev}"; LIVE_HOST="${LIVE_HOST%/}"
LOCAL_PG="${LOCAL_PG:-postgresql://localhost/postgres}"
WORK="${WORK:-$HOME/erp-switchover-$STAMP}"
SNAPDB="erp_snapshot_$STAMP"
SNAP_URL="${LOCAL_PG%/*}/$SNAPDB"
mkdir -p "$WORK"
. scripts/lib-load.sh

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ask()  { local a; read -r -p "$* [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ]; }
go_on(){ ask "${1:-Continue?}" || { echo "stopped; nothing further was changed"; exit 1; }; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- a. pre-checks
step "a. Pre-checks"
for c in npx psql pg_dump pg_restore createdb sqlite3 python3 curl git; do
  command -v "$c" >/dev/null || fail "$c not on PATH"
done
$WR whoami 2>&1 | grep -qi "associated with" || fail "wrangler is not logged in (npx wrangler login)"
echo "  wrangler logged in"
[ "$(curl -fsS -m 15 "$WORKER_URL/healthz" || true)" = "ok" ] || fail "$WORKER_URL/healthz is not ok"
echo "  Worker healthy"
secrets="$($WR secret list 2>/dev/null)"
need=(PASSWORD_PEPPER CREDENTIAL_KEY SESSION_SECRET)
[ "${USES_PUSH:-0}" = "1" ] && need+=(FCM_SERVICE_ACCOUNT)
for s in "${need[@]}"; do
  printf '%s' "$secrets" | grep -q "\"$s\"" || fail "Worker secret $s is not set (npx wrangler secret put $s)"
  echo "  secret $s present"
done
printf '%s' "$secrets" | grep -q '"FCM_SERVICE_ACCOUNT"' || echo "  note: FCM_SERVICE_ACCOUNT not set; push notifications will not send (USES_PUSH=1 to require it)"
[ -f ../deploy/cloudrun/.env.cloudrun ] || fail "deploy/cloudrun/.env.cloudrun missing (MIGRATE_DATABASE_URL)"
set -a; . ../deploy/cloudrun/.env.cloudrun; set +a
[ -n "${MIGRATE_DATABASE_URL:-}" ] || fail "MIGRATE_DATABASE_URL not in .env.cloudrun"
psql "$LOCAL_PG" -XAtc 'SELECT 1' >/dev/null || fail "local Postgres at $LOCAL_PG is not reachable"
echo "  local Postgres reachable; pg_dump $(pg_dump --version | awk '{print $NF}') (must be >= Neon's server version)"
free_kb="$(df -Pk "$WORK" | awk 'NR==2{print $4}')"
echo "  free disk at $WORK: $((free_kb / 1024 / 1024)) GB"
[ "$free_kb" -gt $((5 * 1024 * 1024)) ] || { echo "  WARNING: under 5 GB free (dump + restore + exports)"; go_on "Continue anyway?"; }
git -C .. diff --quiet -- web/wrangler.toml worker/wrangler.jsonc || fail "web/wrangler.toml or worker/wrangler.jsonc has uncommitted changes; commit or stash first"
go_on "Pre-checks passed. Go to the write freeze?"

# ------------------------------------------------------------- b. write freeze
step "b. Write freeze"
cat <<'TXT'
  The Go server has no maintenance or read-only mode, and Cloud Run cannot
  serve a maintenance page in front of it without a redeploy. So:
    1. Announce the pause to staff at both schools (no entries, fee receipts,
       attendance or uploads until you say so; about an hour).
    2. At the announced time, check nobody is mid-entry.
  Anything written on the old site after the snapshot below will NOT reach
  D1. (The hard option, if you need it: in the Neon console run
  ALTER DATABASE <db> SET default_transaction_read_only = on; the old site
  then errors on every write, including sign-in. Undo it only on rollback.)
TXT
go_on "Writes are paused. Take the snapshot?"

# ------------------------------------------------------ c. snapshot and load
step "c1. Snapshot Neon (pg_dump, read-only) -> $WORK/neon.dump"
PGOPTIONS='-c default_transaction_read_only=on' \
  pg_dump "$MIGRATE_DATABASE_URL" --format=custom --no-owner --no-acl --file="$WORK/neon.dump"
ls -lh "$WORK/neon.dump"

step "c2. Restore into local Postgres $SNAPDB"
createdb --maintenance-db="$LOCAL_PG" "$SNAPDB"
# Neon-only roles and extensions may complain; the tables and rows are what count.
pg_restore --no-owner --no-acl --dbname="$SNAP_URL" "$WORK/neon.dump" 2> "$WORK/restore.log" || \
  { echo "  pg_restore reported errors (see $WORK/restore.log):"; grep -m 10 ERROR "$WORK/restore.log" || true; go_on "Carry on with this restore?"; }

step "c3. Schools in the snapshot"
SCHOOLS=(); while IFS= read -r l; do [ -n "$l" ] && SCHOOLS+=("$l"); done < <(psql "$SNAP_URL" -XAt -F ' ' -c "SELECT slug, id FROM institutions ORDER BY slug")
[ "${#SCHOOLS[@]}" -gt 0 ] || fail "no institutions in the snapshot"
printf '  %s\n' "${SCHOOLS[@]}"
PLATFORM=(); while IFS= read -r l; do [ -n "$l" ] && PLATFORM+=("$l"); done < <(psql "$SNAP_URL" -XAt -c "SELECT id FROM users WHERE institution_id IS NULL ORDER BY id")
echo "  platform accounts (institution_id NULL): ${#PLATFORM[@]}"
go_on "Export and load these ${#SCHOOLS[@]} schools into new D1 databases (stamp $STAMP)?"

for row in "${SCHOOLS[@]}"; do
  read -r slug inst <<<"$row"
  step "c4. Export $slug"
  python3 ../scripts/d1/pg_to_d1.py "$SNAP_URL" "$WORK/$slug" "$inst"
  load_school "$slug" "$inst" "$WORK/$slug" ${PLATFORM[@]+"${PLATFORM[@]}"}
  echo "$LOADED_DB" > "$WORK/$slug/d1-name"
done
if [ "${#PLATFORM[@]}" -gt 0 ]; then
  step "c5. Platform accounts into CONTROL"
  load_platform "$SNAP_URL" "$WORK/platform.sql" "${PLATFORM[@]}"
fi

# ------------------------------------------------------------------ d. verify
step "d. Verify row counts, every table, every school"
for row in "${SCHOOLS[@]}"; do
  read -r slug inst <<<"$row"
  name="$(cat "$WORK/$slug/d1-name")"
  echo "  $slug ($name)"
  verify_counts "$name" "$WORK/$slug/school_erp.db" "${#PLATFORM[@]}" \
    || fail "$slug: D1 does not match the snapshot. The live site is untouched; lift the pause and investigate."
done
echo "  all counts match"
go_on "Counts match. Go to files?"

# ------------------------------------------------------------------- e. files
step "e. Files: FILES_WRITE -> the live bucket school-erp"
python3 - <<'PY'
s = open("wrangler.jsonc").read()
old = '{ "binding": "FILES_WRITE", "bucket_name": "school-erp-d1-uploads" }'
new = '{ "binding": "FILES_WRITE", "bucket_name": "school-erp" }'
if old in s:
    open("wrangler.jsonc", "w").write(s.replace(old, new)); print("  wrangler.jsonc: FILES_WRITE now school-erp")
elif new in s:
    print("  wrangler.jsonc: FILES_WRITE already school-erp")
else:
    raise SystemExit("FILES_WRITE binding not found in wrangler.jsonc")
PY
echo "  Objects uploaded during testing sit in school-erp-d1-uploads. They belong to"
echo "  test sessions against copies of the data and are normally NOT wanted live."
if ask "Copy them into school-erp (existing objects are never overwritten)?"; then
  if command -v rclone >/dev/null && rclone listremotes | grep -q '^r2:$'; then
    rclone copy r2:school-erp-d1-uploads r2:school-erp --ignore-existing --progress
  else
    echo "  rclone with an 'r2:' remote is not configured. Copy by hand, e.g."
    echo "    rclone copy r2:school-erp-d1-uploads r2:school-erp --ignore-existing"
    go_on "Done copying by hand (or decided against it)?"
  fi
fi
go_on "Deploy the Worker with the new school databases and the live bucket?"
$WR deploy | grep -E "https://|rror"
[ "$(curl -fsS -m 15 "$WORKER_URL/healthz" || true)" = "ok" ] || fail "Worker unhealthy after deploy"
git -C .. add worker/wrangler.jsonc
git -C .. commit -m "Switchover: school databases stamped $STAMP, uploads to the live bucket" -- worker/wrangler.jsonc

# ------------------------------------------------ f. point the live site
step "f. Point the live site at the Worker"
python3 - "$WORKER_URL" <<'PY'
import re, sys
p = "../web/wrangler.toml"
s = open(p).read()
s2, n = re.subn(r'^API_ORIGIN = "[^"]*"', f'API_ORIGIN = "{sys.argv[1]}"', s, flags=re.M)
if n != 1: raise SystemExit("API_ORIGIN line not found in web/wrangler.toml")
open(p, "w").write(s2)
PY
git -C .. diff -- web/wrangler.toml
go_on "Commit this API_ORIGIN change?"
git -C .. commit -m "Switchover: the edge proxies to the Worker on D1" -- web/wrangler.toml
echo "  Pages builds from git. Pushing starts the switch for every user."
if ask "Push to origin now (git fetch + push)?"; then
  git -C .. fetch origin
  git -C .. push origin HEAD:main
else
  echo "  Not pushed. Run: git push origin HEAD:main, then continue here once Pages has built."
fi
go_on "Pages build finished (dashboard shows the new deployment live)?"

# -------------------------------------------------------------- g. post-checks
step "g. Post-checks through $LIVE_HOST"
check() { # path expected-status...
  local path="$1"; shift; local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$LIVE_HOST$path")"
  for e in "$@"; do [ "$code" = "$e" ] && { echo "  ok   $code $path"; return 0; }; done
  echo "  BAD  $code $path (wanted $*)"; return 1
}
bad=0
check /healthz 200 || bad=1
check /api/v1/session 200 401 || bad=1
check / 200 || bad=1
check /login 200 || bad=1
# Read endpoints without a session: 401 from the Worker proves the proxy
# reaches it and the route exists (a 404/5xx does not).
for p in /api/v1/students /api/v1/academics/classes /api/v1/communication/circulars; do check "$p" 200 401 403 || bad=1; done
[ "$bad" = 0 ] || echo "  some checks failed; consider rollback (below)"
cat <<TXT

  Now sign in on $LIVE_HOST as a real staff member at each school and open:
  dashboard, a student profile, fee receipts, attendance. Then lift the pause.
TXT
ask "Signed in and it looks right?" && echo "  Switched. Keep the rollback below for a week." || echo "  Not right: follow the rollback below."

# ------------------------------------------------------------------ h. rollback
step "h. Rollback (read now, keep for a week)"
cat <<TXT
  1. git revert the "the edge proxies to the Worker on D1" commit (API_ORIGIN
     back to the Cloud Run URL) and push; Pages rebuilds and the old site
     serves again. If you set Neon read-only in step b, run
     ALTER DATABASE <db> RESET default_transaction_read_only in the Neon console.
  2. Neon was only read. It is exactly as it was at the pause and stays the
     source of truth until you decide otherwise; keep Cloud Run and Neon up.
  3. Anything written on D1 after the switch (new entries, receipts,
     attendance, uploads to school-erp) is NOT copied back to Neon and is lost
     to the old site on rollback. Files uploaded meanwhile stay in the bucket
     but nothing on Neon points at them.
  4. Snapshot kept at $WORK/neon.dump and local DB $SNAPDB; drop them when done.
  Old D1 databases (earlier stamps) can be deleted from the dashboard.
TXT
