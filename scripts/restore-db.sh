#!/usr/bin/env bash
# Restore one tenant database from a nightly dump, into a NEW database.
#
# WHY THIS EXISTS AS A SCRIPT: a backup nobody has restored is a hope, and the
# first time this was tried by hand the obvious incantation produced a database
# the application could not read. `pg_restore --no-owner --no-privileges` is
# what half the internet recommends and what most people reach for, and here it
# restores all 416 row-level-security policies and NONE of the 1732 grants to
# app_user. Every table comes back, every policy comes back, and every query
# the app makes fails with permission denied. The data looks perfect from psql
# as the superuser, which is exactly how somebody concludes the restore worked
# and finds out otherwise once the school is live on it.
#
# So: no --no-owner, no --no-privileges. The roles this dump names already
# exist on this box; on a different box, create them first.
#
# Restores into a NEW database on purpose. Restoring over a live one is how a
# recovery from yesterday's mistake becomes today's outage, and comparing the
# two before you switch is the whole point of having the copy.
set -euo pipefail

DUMP=${1:-}
TARGET=${2:-}

if [ -z "$DUMP" ] || [ -z "$TARGET" ]; then
    echo "usage: $0 <dump-file> <new-database-name>" >&2
    echo "  e.g. $0 /var/backups/temperp/nightly/temperp-20260902-193030.dump temperp_check" >&2
    echo >&2
    echo "newest dumps:" >&2
    ls -t /var/backups/temperp/nightly/*.dump 2>/dev/null | head -5 >&2
    exit 2
fi
[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }

if sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='$TARGET'" | grep -q 1; then
    echo "$TARGET already exists. Drop it yourself if that is what you meant." >&2
    exit 1
fi

sudo -u postgres createdb "$TARGET"
sudo -u postgres pg_restore -d "$TARGET" "$DUMP"

# WHAT A GOOD RESTORE LOOKS LIKE, checked rather than assumed. The row counts
# are the easy half; the grants are the half that was actually missing.
grants=$(sudo -u postgres psql -d "$TARGET" -Atc \
    "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='app_user'")
policies=$(sudo -u postgres psql -d "$TARGET" -Atc "SELECT count(*) FROM pg_policies")
forced=$(sudo -u postgres psql -d "$TARGET" -Atc \
    "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity")
schools=$(sudo -u postgres psql -d "$TARGET" -Atc "SELECT count(*) FROM institutions")

printf 'restored into %s\n  schools  %s\n  policies %s (forced %s)\n  grants   %s to app_user\n' \
    "$TARGET" "$schools" "$policies" "$forced" "$grants"

if [ "$grants" -eq 0 ]; then
    echo "!! NO GRANTS. The app cannot read this database. Restore again without" >&2
    echo "   --no-owner or --no-privileges." >&2
    exit 1
fi
echo "Point a copy of the app at it before switching anything over."
