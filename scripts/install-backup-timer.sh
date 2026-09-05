#!/usr/bin/env bash
# Install (or remove) the nightly database backup as a systemd timer on the VPS.
#
# Runs ON the server as root, next to deploy.sh. Idempotent: re-running
# rewrites the two unit files, reloads systemd and makes sure the timer is
# enabled and running; nothing else changes. `--uninstall` stops and removes
# them and leaves the backups on disk and in R2 alone.
#
#   sudo bash scripts/install-backup-timer.sh
#   sudo bash scripts/install-backup-timer.sh --uninstall
#   sudo bash scripts/install-backup-timer.sh --run-now    # install, then fire once
#
# 01:30 IST, when nobody at a school is doing anything, and after the ERP's
# own end-of-day jobs. The service reads /etc/${SERVICE}.env -- the same file
# deploy.sh writes and the ERP itself runs from -- so the R2 credentials and
# the database URL are configured in exactly one place. Output goes to the
# journal: `journalctl -u temperp-backup.service -n 50`.
set -euo pipefail

SERVICE=${SERVICE:-temperp}
APP_DIR=${APP_DIR:-/opt/${SERVICE}}
ENV_FILE=${ENV_FILE:-/etc/${SERVICE}.env}
UNIT="${SERVICE}-backup"
# systemd takes a timezone on OnCalendar (v228+, so any supported Ubuntu), so
# this is 01:30 Indian time whatever the box's own clock is set to.
ON_CALENDAR=${ON_CALENDAR:-*-*-* 01:30:00 Asia/Kolkata}
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
    systemctl disable --now "$UNIT.timer" 2>/dev/null || true
    rm -f "/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service"
    systemctl daemon-reload
    echo "removed $UNIT.timer and $UNIT.service (backups on disk and in R2 untouched)"
    exit 0
fi

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE does not exist -- run deploy.sh first" >&2; exit 1; }
[ -f "$HERE/backup-db.sh" ] || { echo "backup-db.sh not found next to this script" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump is not installed" >&2; exit 1; }
if ! command -v rclone >/dev/null && ! command -v aws >/dev/null; then
    echo "warning: neither rclone nor the aws cli is installed; the timer will fail until one is (apt install rclone)" >&2
fi
if grep -q '^R2_ACCESS_KEY_ID=REPLACE_ME' "$ENV_FILE"; then
    echo "warning: R2_ACCESS_KEY_ID is still REPLACE_ME in $ENV_FILE; the timer will fail until the R2 block is filled in" >&2
fi

install -d "$APP_DIR"
install -o root -g root -m 0755 "$HERE/backup-db.sh" "$APP_DIR/backup-db.sh"
install -d -m 0700 "/var/backups/${SERVICE}/nightly"

cat > "/etc/systemd/system/$UNIT.service" <<UNIT
[Unit]
Description=${SERVICE} nightly database backup to R2
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Same file the ERP runs from: DATABASE_URL, MIGRATE_DATABASE_URL, R2_*.
EnvironmentFile=${ENV_FILE}
Environment=SERVICE=${SERVICE}
Environment=BACKUP_DIR=/var/backups/${SERVICE}/nightly
ExecStart=/usr/bin/env bash ${APP_DIR}/backup-db.sh
# Root: reads the env file and dumps as the postgres superuser over the
# socket, which is what bypasses row-level security. See backup-db.sh.
User=root
Nice=15
IOSchedulingClass=idle
TimeoutStartSec=2h
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT}
UNIT

cat > "/etc/systemd/system/$UNIT.timer" <<UNIT
[Unit]
Description=${SERVICE} nightly database backup, 01:30 IST

[Timer]
OnCalendar=${ON_CALENDAR}
# A box that was off at 01:30 runs the backup when it comes back.
Persistent=true
RandomizedDelaySec=5m
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now "$UNIT.timer" >/dev/null
systemd-analyze calendar "$ON_CALENDAR" | grep -E 'Next elapse|From now' || true
systemctl list-timers "$UNIT.timer" --no-pager | head -2

if [ "${1:-}" = "--run-now" ]; then
    echo "running $UNIT.service once..."
    systemctl start "$UNIT.service"
    journalctl -u "$UNIT.service" -n 20 --no-pager
fi
echo "installed. logs: journalctl -u $UNIT.service"
