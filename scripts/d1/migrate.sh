#!/usr/bin/env bash
# Copy the production Postgres (Neon) into a Cloudflare D1 database.
#
#   scripts/d1/migrate.sh export     read Neon, write out/ (schema.sql, data.sql, report.md)
#   scripts/d1/migrate.sh local      load out/ into wrangler's local D1 and count rows
#   scripts/d1/migrate.sh remote     create the D1 database (once) and load out/ into it
#   scripts/d1/migrate.sh all        the three in order
#
# `export` reads DATABASE_URL from the environment, or from
# deploy/cloudrun/.env.cloudrun when unset. `remote` needs `wrangler login`
# to have been run once on this machine. Nothing here writes to Postgres.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$HERE/out}"
export PATH="$HOME/tools/node22/bin:$PATH"
WR="npx --yes wrangler@4"
DB_NAME="${D1_NAME:-school-erp}"

export_step() {
    if [ -z "${DATABASE_URL:-}" ]; then
        set -a; . "$ROOT/deploy/cloudrun/.env.cloudrun"; set +a
    fi
    python3 "$HERE/pg_to_d1.py" "$DATABASE_URL" "$OUT"
    echo "wrote $OUT; read $OUT/report.md before going further" >&2
}

local_step() {
    cd "$HERE"
    rm -rf .wrangler
    $WR d1 execute "$DB_NAME" --local --file="$OUT/schema.sql" >/dev/null
    $WR d1 execute "$DB_NAME" --local --file="$OUT/data.sql" >/dev/null
    $WR d1 execute "$DB_NAME" --local --json --command \
        "select (select count(*) from sqlite_master where type='table') tables, (select count(*) from pragma_foreign_key_check) fk_violations, (select count(*) from students) students, (select count(*) from users) users" \
        | grep -A6 '"results"'
}

remote_step() {
    cd "$HERE"
    $WR whoami >/dev/null 2>&1 || { echo "run: npx wrangler@4 login" >&2; exit 1; }
    if grep -q REPLACE_AFTER_CREATE wrangler.toml; then
        id="$($WR d1 create "$DB_NAME" 2>/dev/null | grep -o '"database_id": *"[^"]*"' | cut -d'"' -f4)"
        [ -n "$id" ] || { echo "could not read database_id from wrangler d1 create; if it already exists, paste its id into wrangler.toml" >&2; exit 1; }
        sed -i '' "s/REPLACE_AFTER_CREATE/$id/" wrangler.toml
        echo "created D1 database $DB_NAME ($id)" >&2
    fi
    $WR d1 execute "$DB_NAME" --remote --yes --file="$OUT/schema.sql"
    $WR d1 execute "$DB_NAME" --remote --yes --file="$OUT/data.sql"
    $WR d1 execute "$DB_NAME" --remote --json --command \
        "select (select count(*) from sqlite_master where type='table') tables, (select count(*) from students) students, (select count(*) from users) users" \
        | grep -A5 '"results"'
}

case "${1:-}" in
    export) export_step ;;
    local)  local_step ;;
    remote) remote_step ;;
    all)    export_step; local_step; remote_step ;;
    *)      sed -n '2,12p' "$0"; exit 2 ;;
esac
