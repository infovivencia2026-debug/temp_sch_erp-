#!/usr/bin/env bash
# Called by scripts/deploy-guard.sh. Refuses a deploy while CONTROL or any
# school's database has migrations this tree carries but the remote has not
# run: the new code would query tables and columns that are not there yet.
# Only reads status (`migrate.mjs status --remote`); never applies anything.
# Override, knowingly, with ALLOW_PENDING_MIGRATIONS=1.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)/worker"
if [ "${ALLOW_PENDING_MIGRATIONS:-}" = 1 ]; then
  echo "deploy-preflight: pending-migration check skipped (ALLOW_PENDING_MIGRATIONS=1)"
  exit 0
fi
out=$(node scripts/migrate.mjs status --remote 2>&1)
code=$?
pending=$(printf '%s\n' "$out" | grep -E ': [0-9]+ applied, [1-9][0-9]* pending|^  pending ' || true)
errors=$(printf '%s\n' "$out" | grep -E 'ERROR' || true)
if [ $code != 0 ] || [ -n "$pending" ] || [ -n "$errors" ]; then
  echo "deploy-preflight: refused, the remote databases are not on this tree's schema."
  [ -n "$pending" ] && printf '%s\n' "$pending"
  [ -n "$errors" ] && printf '%s\n' "$errors"
  [ -z "$pending$errors" ] && printf '%s\n' "$out" | tail -5
  echo "Run: cd worker && node scripts/migrate.mjs up --remote   (or ALLOW_PENDING_MIGRATIONS=1 to deploy anyway)"
  exit 1
fi
echo "deploy-preflight: OK, CONTROL and every school have no pending migrations"
