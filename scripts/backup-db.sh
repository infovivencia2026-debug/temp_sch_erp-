#!/usr/bin/env bash
# Nightly dump of the ERP database, kept off the box in Cloudflare R2.
#
# WHY THIS EXISTS: there was no scheduled backup at all, and then there was a
# scheduled backup that lived on the same disk as the database it protected.
# A VPS that dies takes both with it. For a product holding a school's fee
# receipts and its children's records the one copy that matters is the one
# that is somewhere else, so this script's job is not done until an object
# with the right size is listed back from the bucket.
#
# pg_dump -Fc, not plain SQL. The custom format is compressed, and pg_restore
# can take a single table out of it, which is what an operator actually needs
# at eight in the morning when one table was truncated by mistake. A plain
# .sql.gz can only be replayed whole. (If BACKUP_FORMAT is set to anything but
# custom, the file is gzipped, because pg_dump only compresses -Fc itself.)
#
# Works against the VPS (postgres://...@127.0.0.1/...?sslmode=disable) and
# against Neon (postgres://...@ep-xxx.neon.tech/...?sslmode=require): pg_dump
# takes the URL as-is, TLS included.
#
# ROW-LEVEL SECURITY. Every tenant table has FORCE ROW LEVEL SECURITY, so the
# role that dumps must bypass RLS: a superuser or a role with BYPASSRLS. With
# any other role pg_dump stops with "query would be affected by row-level
# security policy" -- loud, on purpose. On the VPS the script therefore dumps
# through the local postgres superuser when it can (root, local socket), the
# way the first version of this script did; on Neon the database owner has
# BYPASSRLS through neon_superuser (verify once with --restore-check).
#
# Usage:
#   backup-db.sh                       nightly run (timer, or by hand as root)
#   backup-db.sh --restore-check       ...then restore into RESTORE_URL and
#                                      compare the table count with the source
#   R2_DRY_RUN=1 backup-db.sh          upload to a local directory instead of R2
#
# Configuration, from the environment or from ENV_FILE (default
# /etc/${SERVICE}.env, the file deploy.sh writes). No secret is ever an
# argument: `ps` shows arguments to every user on the box.
#
#   BACKUP_DATABASE_URL   what to dump; falls back to MIGRATE_DATABASE_URL
#                         (the owner), then DATABASE_URL (the app role, which
#                         cannot bypass RLS and so cannot dump -- see above)
#   R2_BUCKET             bucket; R2_PREFIX optional folder in front of backups/
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   the same names the
#                         app reads; R2_ENDPOINT is derived from the account id
#   R2_REMOTE             rclone remote name if rclone is installed (default r2);
#                         if that remote is not configured, one is built from
#                         the R2_* variables for the duration of the run
#   RETAIN_DAYS           objects older than this are deleted after a good
#                         upload (default 30)
#   BACKUP_DIR            local staging + short local history (default
#                         /var/backups/${SERVICE}/nightly); LOCAL_RETAIN_DAYS 7
#   BACKUP_TZ             timezone for the file name (default Asia/Kolkata)
#   RESTORE_URL           scratch database for --restore-check; must be empty
#                         unless RESTORE_CHECK_RESET=1 (drops schema public)
#   R2_DRY_RUN=1          "upload" into R2_DRY_RUN_DIR (default
#                         $BACKUP_DIR/r2-dry-run) so the whole path can be
#                         exercised on a box with no credentials
#
# Exit status is non-zero if any step fails: dump, verify, upload, listing,
# or the restore check. Retention runs only after a verified upload, so a bad
# night never deletes the good nights before it.
set -euo pipefail

started=$(date +%s)
SERVICE=${SERVICE:-temperp}
ENV_FILE=${ENV_FILE:-/etc/${SERVICE}.env}
RESTORE_CHECK=0
for arg in "$@"; do
    case "$arg" in
        --restore-check) RESTORE_CHECK=1 ;;
        -h|--help) sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

die() { echo "backup: $*" >&2; exit 1; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---- configuration ---------------------------------------------------------
# Variables already in the environment win over the file, so a one-off
# `RETAIN_DAYS=7 backup-db.sh` behaves as typed.
if [ -r "$ENV_FILE" ]; then
    while IFS= read -r line; do
        case "$line" in ''|'#'*) continue ;; esac
        key=${line%%=*}
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        if [ -z "${!key+x}" ]; then export "$line"; fi
    done < "$ENV_FILE"
fi

URL=${BACKUP_DATABASE_URL:-${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}}
[ -n "$URL" ] || die "no BACKUP_DATABASE_URL, MIGRATE_DATABASE_URL or DATABASE_URL (looked in $ENV_FILE)"

RETAIN_DAYS=${RETAIN_DAYS:-30}
LOCAL_RETAIN_DAYS=${LOCAL_RETAIN_DAYS:-7}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/${SERVICE}/nightly}
BACKUP_FORMAT=${BACKUP_FORMAT:-custom}
BACKUP_TZ=${BACKUP_TZ:-Asia/Kolkata}
R2_DRY_RUN=${R2_DRY_RUN:-0}
R2_PREFIX=${R2_PREFIX:-}

# Database name and host out of the URL. Only the path and host are needed,
# so this is deliberately not a full URL parser.
rest=${URL#*://}
hostpart=${rest#*@}; hostpart=${hostpart%%/*}; DB_HOST=${hostpart%%:*}
DB_NAME=${rest#*@}; DB_NAME=${DB_NAME#*/}; DB_NAME=${DB_NAME%%\?*}
[ -n "$DB_NAME" ] || die "cannot read a database name from the URL"

STAMP=$(TZ="$BACKUP_TZ" date +%Y-%m-%dT%H%M)
EXT=dump
[ "$BACKUP_FORMAT" = custom ] || EXT=sql.gz
FILE="$STAMP.$EXT"
KEY_DIR="${R2_PREFIX:+$R2_PREFIX/}backups/$DB_NAME"
KEY="$KEY_DIR/$FILE"

mkdir -p "$BACKUP_DIR/$DB_NAME" || die "cannot create $BACKUP_DIR"
LOCAL="$BACKUP_DIR/$DB_NAME/$FILE"

# ---- which pg_dump, as whom ------------------------------------------------
# root on a box with a local postgres OS user and a local database: dump as
# the superuser over the socket. It bypasses RLS and needs no password. Set
# BACKUP_VIA_SOCKET=0 to force the URL instead (a BYPASSRLS role, say).
DUMP=(pg_dump --format="$BACKUP_FORMAT" --no-password)
[ "$BACKUP_FORMAT" = custom ] || DUMP+=(--no-owner)
case "$DB_HOST" in 127.0.0.1|localhost|"") local_db=1 ;; *) local_db=0 ;; esac
if [ "${BACKUP_VIA_SOCKET:-1}" = 1 ] && [ "$local_db" = 1 ] && [ "$(id -u)" = 0 ] && id -u postgres >/dev/null 2>&1; then
    DUMP=(sudo -u postgres "${DUMP[@]}" "$DB_NAME")
    HOW="as OS user postgres over the socket"
else
    DUMP+=("$URL")
    HOW="via URL as the role in it"
fi
command -v pg_dump >/dev/null || die "pg_dump not installed"
command -v pg_restore >/dev/null || die "pg_restore not installed"

# ---- the object store ------------------------------------------------------
# Three implementations of put/list/rm, chosen once: a local directory for
# dry runs, rclone if present (the way refresh-tiles.sh mirrors), else the
# aws cli. `list` prints "<size> <basename>" per object under KEY_DIR.
if [ "$R2_DRY_RUN" = 1 ]; then
    R2_DRY_RUN_DIR=${R2_DRY_RUN_DIR:-$BACKUP_DIR/r2-dry-run}
    mkdir -p "$R2_DRY_RUN_DIR/$KEY_DIR"
    STORE="dry-run directory $R2_DRY_RUN_DIR"
    store_put()  { cp "$1" "$R2_DRY_RUN_DIR/$2"; }
    store_list() { (cd "$R2_DRY_RUN_DIR/$KEY_DIR" && for f in *; do [ -f "$f" ] && printf '%s %s\n' "$(stat -c %s "$f")" "$f"; done; true); }
    store_rm()   { rm -f "$R2_DRY_RUN_DIR/$1"; }
else
    [ -n "${R2_BUCKET:-}" ] || die "R2_BUCKET is unset (and R2_DRY_RUN is not 1)"
    case "${R2_ACCESS_KEY_ID:-}" in ""|REPLACE_ME) die "R2_ACCESS_KEY_ID is not set in $ENV_FILE -- fill in the R2 block deploy.sh left there" ;; esac
    R2_ENDPOINT=${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID or R2_ENDPOINT is required}.r2.cloudflarestorage.com}
    if command -v rclone >/dev/null; then
        R2_REMOTE=${R2_REMOTE:-r2}
        if ! rclone listremotes 2>/dev/null | grep -qx "$R2_REMOTE:"; then
            # No configured remote: rclone reads one from the environment.
            up=$(echo "$R2_REMOTE" | tr '[:lower:]-' '[:upper:]_')
            export "RCLONE_CONFIG_${up}_TYPE=s3" "RCLONE_CONFIG_${up}_PROVIDER=Cloudflare" \
                "RCLONE_CONFIG_${up}_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID" \
                "RCLONE_CONFIG_${up}_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY:?}" \
                "RCLONE_CONFIG_${up}_ENDPOINT=$R2_ENDPOINT" "RCLONE_CONFIG_${up}_NO_CHECK_BUCKET=true"
        fi
        STORE="rclone $R2_REMOTE:$R2_BUCKET"
        store_put()  { rclone copyto "$1" "$R2_REMOTE:$R2_BUCKET/$2" --s3-no-check-bucket -q; }
        store_list() { rclone lsl "$R2_REMOTE:$R2_BUCKET/$KEY_DIR/" 2>/dev/null | awk '{print $1, $NF}'; }
        store_rm()   { rclone deletefile "$R2_REMOTE:$R2_BUCKET/$1" -q; }
    elif command -v aws >/dev/null; then
        export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY:?} \
               AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-auto} AWS_EC2_METADATA_DISABLED=true
        STORE="aws cli s3://$R2_BUCKET"
        store_put()  { aws --endpoint-url "$R2_ENDPOINT" s3 cp "$1" "s3://$R2_BUCKET/$2" --only-show-errors --content-type application/octet-stream; }
        store_list() { aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/$KEY_DIR/" | awk '$NF != "" && $3 ~ /^[0-9]+$/ {print $3, $NF}'; }
        store_rm()   { aws --endpoint-url "$R2_ENDPOINT" s3 rm "s3://$R2_BUCKET/$1" --only-show-errors; }
    else
        die "neither rclone nor the aws cli is installed (apt install rclone, or set R2_DRY_RUN=1)"
    fi
fi

# ---- 1. dump ---------------------------------------------------------------
log "dumping $DB_NAME ($HOW) -> $LOCAL"
# To a temporary name first: a dump interrupted half way through must not sit
# in the directory looking like a backup.
rm -f "$LOCAL.part"
if [ "$BACKUP_FORMAT" = custom ]; then
    "${DUMP[@]}" > "$LOCAL.part" || { rm -f "$LOCAL.part"; die "pg_dump failed"; }
else
    "${DUMP[@]}" | gzip -6 > "$LOCAL.part" || { rm -f "$LOCAL.part"; die "pg_dump | gzip failed"; }
    [ "${PIPESTATUS[0]}" = 0 ] || { rm -f "$LOCAL.part"; die "pg_dump failed"; }
fi
mv "$LOCAL.part" "$LOCAL"
SIZE=$(stat -c %s "$LOCAL")
[ "$SIZE" -gt 1024 ] || die "dump is only $SIZE bytes; refusing to call that a backup"

# A dump that cannot be read is not a backup. Listing the table of contents
# catches a truncated file the night it is written rather than the morning
# it is wanted.
if [ "$BACKUP_FORMAT" = custom ]; then
    TABLES_IN_DUMP=$(pg_restore --list "$LOCAL" | grep -c '[0-9] TABLE public ' || true)
    [ "$TABLES_IN_DUMP" -gt 0 ] || die "pg_restore --list found no tables in $LOCAL"
    log "dump ok: $(numfmt --to=iec "$SIZE") , $TABLES_IN_DUMP tables"
else
    gzip -t "$LOCAL" || die "gzip integrity check failed on $LOCAL"
    TABLES_IN_DUMP=$(zcat "$LOCAL" | grep -c '^CREATE TABLE ' || true)
    log "dump ok: $(numfmt --to=iec "$SIZE") , $TABLES_IN_DUMP tables"
fi

# ---- 2. upload and verify by listing ----------------------------------------
log "uploading to $STORE/$KEY"
store_put "$LOCAL" "$KEY" || die "upload failed"
REMOTE_SIZE=$(store_list | awk -v f="$FILE" '$2 == f {print $1}')
[ -n "$REMOTE_SIZE" ] || die "uploaded object $KEY is not in the listing"
[ "$REMOTE_SIZE" = "$SIZE" ] || die "size mismatch: local $SIZE, remote $REMOTE_SIZE"
log "verified: $KEY listed with $REMOTE_SIZE bytes"

# ---- 3. retention ----------------------------------------------------------
# By the date in the object name, not by modification time: a re-upload of an
# old dump would otherwise be young again. Only reached after a verified
# upload -- pruning on a night when the dump failed is how a month of backups
# disappears the week before they are needed.
cutoff=$(date -u -d "-$RETAIN_DAYS days" +%Y-%m-%d)
removed=0; kept=0
while read -r _ name; do
    d=${name:0:10}
    [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    if [[ "$d" < "$cutoff" ]]; then
        store_rm "$KEY_DIR/$name" && removed=$((removed+1))
    else
        kept=$((kept+1))
    fi
done < <(store_list)
log "retention: kept $kept, removed $removed older than $cutoff (RETAIN_DAYS=$RETAIN_DAYS)"
find "$BACKUP_DIR/$DB_NAME" -name "*.$EXT" -mtime +"$LOCAL_RETAIN_DAYS" -delete

# ---- 4. optional restore check -----------------------------------------------
# WHAT A GOOD BACKUP LOOKS LIKE, checked rather than assumed: every table in
# the dump comes back in a scratch database. This is a readability check with
# --no-owner --no-privileges so it works where the production roles do not
# exist; it is NOT the recovery procedure -- that is scripts/restore-db.sh,
# which keeps owners and grants because the app cannot read a database
# without them.
if [ "$RESTORE_CHECK" = 1 ]; then
    [ -n "${RESTORE_URL:-}" ] || die "--restore-check needs RESTORE_URL"
    [ "$RESTORE_URL" != "$URL" ] || die "RESTORE_URL is the source database"
    [ "$BACKUP_FORMAT" = custom ] || die "--restore-check needs BACKUP_FORMAT=custom"
    existing=$(psql "$RESTORE_URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'") \
        || die "cannot connect to RESTORE_URL"
    if [ "$existing" != 0 ]; then
        [ "${RESTORE_CHECK_RESET:-0}" = 1 ] || die "RESTORE_URL already has $existing tables; set RESTORE_CHECK_RESET=1 to drop schema public first"
        psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
    fi
    log "restore check into $(echo "$RESTORE_URL" | sed -E 's#//[^@]*@#//***@#')"
    restore_log=$(mktemp)
    pg_restore --no-owner --no-privileges --no-password -d "$RESTORE_URL" "$LOCAL" 2>"$restore_log" || true
    RESTORED=$(psql "$RESTORE_URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
    ERRORS=$(grep -c 'pg_restore: error' "$restore_log" || true)
    if [ "$RESTORED" != "$TABLES_IN_DUMP" ]; then
        grep 'pg_restore: error' "$restore_log" | head -20 >&2
        rm -f "$restore_log"
        die "restore check FAILED: $RESTORED tables restored, $TABLES_IN_DUMP in the dump"
    fi
    [ "$ERRORS" = 0 ] || { log "restore finished with $ERRORS pg_restore errors (roles/extensions missing on the scratch server?):"; grep 'pg_restore: error' "$restore_log" | head -5; }
    rm -f "$restore_log"
    log "restore check ok: $RESTORED tables"
fi

log "done: $DB_NAME $FILE $(numfmt --to=iec "$SIZE") ($SIZE bytes) in $(( $(date +%s) - started ))s"
