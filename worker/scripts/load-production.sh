#!/usr/bin/env bash
# Load the two production schools into Cloudflare D1 and point the Worker at
# the real password key. Run it yourself from the repo root:
#
#   bash worker/scripts/load-production.sh
#
# Reads the per-school exports made by scripts/d1/pg_to_d1.py (read-only on
# Neon) from EXPORTS. Creates one D1 database per school, applies the schema,
# adds a stand-in row for the platform staff account (rows in each school link
# to it; it cannot sign in there, it signs in through CONTROL), loads the data,
# registers each school and its sign-ins in CONTROL, copies the platform
# account into CONTROL, sets PASSWORD_PEPPER to the Cloud Run value, and
# redeploys. Neon and the live site are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/tools/node22/bin:$PATH"
WR="npx wrangler"
EXPORTS="${EXPORTS:-/private/tmp/claude-501/-Users-mukesh-temp-sch-erp-/60c64de6-7c20-4ce1-98fe-15cbd44cbec1/scratchpad/snap}"
# Each run loads into NEW databases named with this stamp, so the copy is
# exactly the snapshot, with nothing left over from an earlier load. The
# Worker's TENANT_<SLUG> binding is moved to the new database; older ones are
# left in place for you to delete from the Cloudflare dashboard.
STAMP="${STAMP:-$(date +%Y%m%d%H%M)}"
PLATFORM_USER=1cfcdfd0-bfcb-41d1-97b0-d8455771f957
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# slug  institution id                          export folder
SCHOOLS=(
  "yajur f0455c35-f2f2-4b4e-86ef-05f40933f39c yajur"
  "jsm   3ab6c3f7-01a5-4df3-8a0b-558b2b5e1577 jsm"
)

. scripts/lib-load.sh

for row in "${SCHOOLS[@]}"; do
  read -r slug inst dir <<<"$row"
  load_school "$slug" "$inst" "$EXPORTS/$dir" "$PLATFORM_USER"
done

# The platform staff account, into CONTROL (read-only from Neon).
set -a; . ../deploy/cloudrun/.env.cloudrun; set +a
load_platform "$MIGRATE_DATABASE_URL" "$EXPORTS/platform.sql" "$PLATFORM_USER"

# The real password key, so every existing password verifies.
printf '%s' "$PASSWORD_PEPPER" | $WR secret put PASSWORD_PEPPER
$WR deploy | grep -E "https://|rror"
echo "done: sign in at https://school-erp-d1.pages.dev with a real account"
