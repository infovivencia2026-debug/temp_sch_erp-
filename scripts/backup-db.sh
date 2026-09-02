#!/usr/bin/env bash
# A nightly dump of every tenant database, kept for a month.
#
# WHY THIS EXISTS: there was no scheduled backup at all. Every dump on the box
# was ad hoc, taken by hand before a deploy, so the honest answer to "how much
# would a school lose" was "everything since somebody last remembered". For a
# product holding a school's fee receipts and its children's records that is
# the one gap that cannot be argued down.
#
# pg_dump -Fc, not plain SQL. The custom format is compressed, and pg_restore
# can take a single table out of it, which is what an operator actually needs
# at eight in the morning when one table was truncated by mistake. A plain
# .sql.gz can only be replayed whole.
#
# Written to run from a systemd timer as root, and to be safe to run by hand.
set -euo pipefail

DIR=${BACKUP_DIR:-/var/backups/temperp/nightly}
KEEP_DAYS=${KEEP_DAYS:-30}
STAMP=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$DIR"

# Every non-template database owned by this installation, so a tenant added
# next month is backed up the night it appears rather than the night somebody
# remembers to edit this file.
DBS=$(sudo -u postgres psql -Atc \
  "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'")

fail=0
for db in $DBS; do
  out="$DIR/$db-$STAMP.dump"
  # To a temporary name first: a dump interrupted half way through must not
  # sit in the directory looking like a backup. Only a completed file gets
  # the name the restore procedure looks for.
  if sudo -u postgres pg_dump -Fc "$db" > "$out.part" 2>"$out.err"; then
    mv "$out.part" "$out"
    rm -f "$out.err"
    echo "ok $db $(du -h "$out" | cut -f1)"
  else
    fail=1
    echo "FAILED $db -- see $out.err" >&2
    rm -f "$out.part"
  fi
done

# Age out old dumps only after a successful run. Pruning on a night when every
# dump failed is how a month of backups disappears the week before they are
# needed.
if [ "$fail" -eq 0 ]; then
  find "$DIR" -name '*.dump' -mtime +"$KEEP_DAYS" -delete
fi

# A dump that cannot be read is not a backup. Listing the newest one costs a
# second and catches a truncated or corrupt file the night it is written
# rather than the morning it is wanted.
newest=$(ls -t "$DIR"/*.dump 2>/dev/null | head -1 || true)
if [ -n "$newest" ]; then
  sudo -u postgres pg_restore --list "$newest" > /dev/null || {
    echo "UNREADABLE $newest" >&2
    exit 1
  }
  echo "verified $newest"
fi

exit "$fail"
