#!/usr/bin/env bash
# Nightly backup of the Neon database to R2, from anywhere: GitHub Actions, a
# laptop, any box with pg_dump and the aws cli. This is the Cloud Run + Neon
# phase of docs/arch_lowcost.txt (Stage 6); on the VPS use backup-db.sh via
# install-backup-timer.sh instead, which reads /etc/temperp.env.
#
# The real work is backup-db.sh; this wrapper is what a CI runner needs around
# it: no env file, only the aws cli (rclone is not on a GitHub runner), a
# pg_dump at least as new as the server, a stamp of what it did, and a
# "--verify-only" mode that just asks R2 whether last night happened.
#
#   DATABASE_URL=... R2_BUCKET=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
#   R2_SECRET_ACCESS_KEY=... bash scripts/backup-check.sh
#
#   ... RESTORE_URL=postgres://...neon branch... bash scripts/backup-check.sh
#       also restores into the scratch database and compares table counts
#
#   ... bash scripts/backup-check.sh --verify-only
#       no dump: exit 1 unless the newest object under backups/<db>/ is
#       younger than MAX_AGE_HOURS (default 30)
#
# Every value comes from the environment (GitHub secrets, or `source` a file
# with 0600 permissions); nothing is a command-line argument. Neon URLs carry
# ?sslmode=require, which pg_dump honours as-is.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODE=backup
case "${1:-}" in
    "") ;;
    --verify-only) MODE=verify ;;
    *) echo "usage: $0 [--verify-only]" >&2; exit 2 ;;
esac

die() { echo "backup-check: $*" >&2; exit 1; }

for v in DATABASE_URL R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || die "$v is not set"
done
[ -n "${R2_ENDPOINT:-}${R2_ACCOUNT_ID:-}" ] || die "set R2_ACCOUNT_ID (or R2_ENDPOINT)"
command -v aws >/dev/null || die "aws cli not installed"
command -v pg_dump >/dev/null || die "pg_dump not installed"
export R2_ENDPOINT=${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}
export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-auto} AWS_EC2_METADATA_DISABLED=true
export R2_PREFIX=${R2_PREFIX:-}

rest=${DATABASE_URL#*://}; DB_NAME=${rest#*@}; DB_NAME=${DB_NAME#*/}; DB_NAME=${DB_NAME%%\?*}
KEY_DIR="${R2_PREFIX:+$R2_PREFIX/}backups/$DB_NAME"

if [ "$MODE" = verify ]; then
    MAX_AGE_HOURS=${MAX_AGE_HOURS:-30}
    newest=$(aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/$KEY_DIR/" \
        | awk '$3 ~ /^[0-9]+$/ {print $NF, $3}' | sort | tail -1)
    [ -n "$newest" ] || die "no objects under $KEY_DIR/"
    name=${newest%% *}; size=${newest##* }
    # The stamp in the name is in BACKUP_TZ (Asia/Kolkata unless changed).
    stamp="${name:0:10} ${name:11:2}:${name:13:2}"
    age_h=$(( ( $(date -u +%s) - $(TZ=${BACKUP_TZ:-Asia/Kolkata} date -d "$stamp" +%s) ) / 3600 ))
    echo "newest: $KEY_DIR/$name  $size bytes  ${age_h}h old"
    [ "$age_h" -le "$MAX_AGE_HOURS" ] || die "newest backup is ${age_h}h old (limit $MAX_AGE_HOURS)"
    [ "$size" -gt 1024 ] || die "newest backup is only $size bytes"
    echo "ok"
    exit 0
fi

# pg_dump refuses a server newer than itself. Say so before spending the dump.
server_major=$(psql "$DATABASE_URL" -Atc "SHOW server_version" | cut -d. -f1)
client_major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
echo "server PostgreSQL $server_major, pg_dump $client_major"
[ "$client_major" -ge "$server_major" ] || die "pg_dump $client_major is older than the server ($server_major); install postgresql-client-$server_major"

# The dump goes through backup-db.sh with no env file and a scratch directory,
# so a runner needs no /etc/temperp.env and no /var/backups.
export ENV_FILE=/dev/null
export BACKUP_DATABASE_URL=$DATABASE_URL
export BACKUP_DIR=${BACKUP_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/erp-backup}
export BACKUP_VIA_SOCKET=0
export LOCAL_RETAIN_DAYS=0
args=()
[ -n "${RESTORE_URL:-}" ] && args+=(--restore-check)
bash "$HERE/backup-db.sh" "${args[@]}"

# What is in the bucket now, newest last -- the line a person reads in the
# Actions log to see that retention is doing its job.
echo "objects under $KEY_DIR/:"
aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/$KEY_DIR/" | awk '$3 ~ /^[0-9]+$/ {print "  " $NF, $3}' | sort | tail -5
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### Nightly backup of \`$DB_NAME\`"; echo; echo '```'
      aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/$KEY_DIR/" | awk '$3 ~ /^[0-9]+$/ {print $NF, $3}' | sort | tail -5
      echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
