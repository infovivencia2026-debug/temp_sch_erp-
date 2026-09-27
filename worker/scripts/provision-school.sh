#!/usr/bin/env bash
# Create a school: its own D1 database, the schema, the binding, and its row
# in CONTROL. Run from worker/. Needs `wrangler login` once on this machine.
#
#   scripts/provision-school.sh <slug> "<School name>" "<Short name>" [--local]
#   scripts/provision-school.sh --attach
#
# --local does everything against wrangler's local D1 for development.
#
# Two ways a school comes to exist:
#  - Seller → Schools → New school (src/services/provision.ts) does all of it
#    from the console, with an administrator, roles and subscription, and no
#    deploy: until the Worker has a TENANT_<SLUG> binding, src/tenant.ts reaches
#    the school's database over the D1 HTTP API. That is the normal path.
#  - This script, for local development and for when the console cannot be
#    used. It makes only the database and the institutions rows; create the
#    administrator afterwards (seller console, reset administrator).
#
# --attach writes the binding of every school in (remote) CONTROL that
# wrangler.jsonc does not list yet, i.e. schools made from the console, so the
# next `npx wrangler deploy` serves them through a native binding. Run it, then
# commit wrangler.jsonc and deploy. Safe to run any time; it only adds lines.
set -euo pipefail
cd "$(dirname "$0")/.."
WR="npx --yes wrangler@4"

if [ "${1:-}" = "--attach" ]; then
    rows="$($WR d1 execute CONTROL --remote --json --command \
      "SELECT i.d1_binding, i.d1_database_id, COALESCE(p.db_name, 'school-erp-' || i.slug) AS db_name FROM institutions i LEFT JOIN provisioning p ON p.institution_id = i.id WHERE i.d1_database_id NOT LIKE 'local-%' ORDER BY i.created_at")"
    python3 - "$rows" <<'PY'
import json, re, sys
rows = json.loads(sys.argv[1])[0]["results"]
s = open("wrangler.jsonc").read()
marker = "    // TENANT_<slug> bindings are appended here by scripts/provision-school.sh\n"
added = 0
for r in rows:
    b, i = r["d1_binding"], r["d1_database_id"]
    if f'"{b}"' in s or i in s:
        continue
    line = f'    ,{{ "binding": "{b}", "database_name": "{r["db_name"]}", "database_id": "{i}" }}\n'
    s = s.replace(marker, line + marker)
    print(f"attach {b} -> {i}", file=sys.stderr)
    added += 1
open("wrangler.jsonc", "w").write(s)
print(f"{added} binding(s) added; commit wrangler.jsonc and run npx wrangler deploy", file=sys.stderr)
PY
    exit 0
fi

slug="${1:?slug}"; name="${2:?name}"; short="${3:?short name}"; mode="${4:-}"
[[ "$slug" =~ ^[a-z0-9-]+$ ]] || { echo "slug must be lowercase letters, digits, hyphens" >&2; exit 2; }
binding="TENANT_$(echo "$slug" | tr 'a-z-' 'A-Z_')"
dbname="school-erp-$slug"
target="--remote --yes"; [ "$mode" = "--local" ] && target="--local"

# 1. The database and its binding, unless already there.
if ! grep -q "\"$binding\"" wrangler.jsonc; then
    if [ "$mode" = "--local" ]; then id="local-$slug"; else
        id="$($WR d1 create "$dbname" | grep -o '"database_id": *"[^"]*"' | cut -d'"' -f4)"
        [ -n "$id" ] || { echo "wrangler d1 create gave no database_id" >&2; exit 1; }
    fi
    python3 - "$binding" "$dbname" "$id" <<'PY'
import re, sys
b, n, i = sys.argv[1:]
s = open("wrangler.jsonc").read()
line = f'    ,{{ "binding": "{b}", "database_name": "{n}", "database_id": "{i}" }}\n'
s = s.replace("    // TENANT_<slug> bindings are appended here by scripts/provision-school.sh\n",
              line + "    // TENANT_<slug> bindings are appended here by scripts/provision-school.sh\n")
open("wrangler.jsonc", "w").write(s)
PY
    echo "added binding $binding -> $dbname ($id)" >&2
else
    id="$(grep -o "\"binding\": \"$binding\"[^}]*\"database_id\": *\"[^\"]*\"" wrangler.jsonc | grep -o '"database_id": *"[^"]*"' | cut -d'"' -f4)"
fi

# 2. The schema.
$WR d1 execute "$dbname" $target --file=db/tenant.sql >/dev/null
echo "schema applied to $dbname" >&2

# 3. The row in CONTROL, and a mirror of it in the school's own database:
#    the ported schema still has users.institution_id -> institutions, so the
#    school's database carries exactly one institutions row, its own.
inst="$(python3 -c 'import uuid;print(uuid.uuid4())')"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
$WR d1 execute "$dbname" $target --command \
  "INSERT INTO institutions (id, name, short_name, slug, created_at, updated_at) VALUES ('$inst', '${name//\'/\'\'}', '${short//\'/\'\'}', '$slug', '$now', '$now')" >/dev/null
$WR d1 execute CONTROL $target --command \
  "INSERT INTO institutions (id, name, short_name, slug, d1_database_id, d1_binding, created_at, updated_at) VALUES ('$inst', '${name//\'/\'\'}', '${short//\'/\'\'}', '$slug', '$id', '$binding', '$now', '$now')" >/dev/null
echo "institution $inst ($slug) registered; redeploy the Worker so the binding is live" >&2
echo "$inst"
