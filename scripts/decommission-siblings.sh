#!/usr/bin/env bash
# Leave only this repo's deployment (temperp + its assistant) on the server.
#
# Run ON THE SERVER as root:   bash decommission-siblings.sh
# Or from this Mac:            ssh root@187.127.178.100 'bash -s' < scripts/decommission-siblings.sh
#
# Written from a read-only survey on 2026-09-04. It removes:
#   school-erp   the old sibling deployment (units, binaries, nginx site, webroots, env)
#   divvy        an unrelated app (divvy-master/divvy-node units, nginx site, /opt/divvy)
#   dead state   onrol backup cron pointing at a directory that no longer exists,
#                stale webroot copies, certificates for hostnames with no site
#   caches       /root/.cache/go-build (17G), npm/uv/pip caches, apt cache,
#                journal beyond 100M, rotated logs, /tmp leftovers
# It keeps: temperp-web/worker/backup, ragbot + ollama (temperp proxies /assistant/ to it),
#   postgres, redis (unused by temperp since the queue moved to Postgres; kept
#   because it is not ours to judge), nginx, certbot, /opt/temperp-src (server-side builds), /root/go,
#   /root/backups, existing temperp dumps, /root/ONROL and /root/code (not hosting;
#   may hold uncommitted work -- delete by hand if you are sure).
# Databases school_erp and divvy are DUMPED and KEPT (15 MB + 11 MB); drop them
# later with:  sudo -u postgres dropdb school_erp; sudo -u postgres dropdb divvy
set -euo pipefail

D=/root/backups/decommission-$(date +%Y%m%d-%H%M)
mkdir -p "$D"
echo "== safety copies -> $D"
sudo -u postgres pg_dump -Fc school_erp > "$D/school_erp.dump"
sudo -u postgres pg_dump -Fc divvy      > "$D/divvy.dump"
cp -a /etc/school-erp.env \
      /etc/systemd/system/school-erp-web.service /etc/systemd/system/school-erp-worker.service \
      /etc/systemd/system/divvy-master.service /etc/systemd/system/divvy-node.service \
      /etc/nginx/sites-available/school-erp /etc/nginx/sites-available/divvy \
      /etc/nginx/sites-available/00-default \
      /etc/nginx/snippets/erp-proxy.conf /etc/nginx/snippets/onrol-nocache.conf \
      /etc/cron.d/onrol-backup "$D/" 2>/dev/null || true
cp -a /etc/systemd/system/divvy-master.service.d "$D/" 2>/dev/null || true
tar czf "$D/removed-dirs.tgz" /var/www/vivencia-suite /var/www/edu-erp /var/www/edu-erp-education \
      /opt/school-erp /opt/divvy 2>/dev/null || true

echo "== stop and remove school-erp"
systemctl disable --now school-erp-web school-erp-worker || true
rm -f /etc/systemd/system/school-erp-web.service /etc/systemd/system/school-erp-worker.service
rm -rf /opt/school-erp /var/www/vivencia-suite /var/www/edu-erp /var/www/edu-erp-education \
       /var/www/edu-erp.prev /var/www/edu-erp-education.prev
rm -f /etc/school-erp.env
userdel schoolerp 2>/dev/null || true

echo "== stop and remove divvy"
systemctl disable --now divvy-master divvy-node 2>/dev/null || true
rm -f /etc/systemd/system/divvy-master.service /etc/systemd/system/divvy-node.service
rm -rf /etc/systemd/system/divvy-master.service.d /opt/divvy
systemctl daemon-reload

echo "== nginx: drop the two sites, point the default vhost at the temperp certificate"
rm -f /etc/nginx/sites-enabled/school-erp /etc/nginx/sites-available/school-erp \
      /etc/nginx/sites-enabled/divvy /etc/nginx/sites-available/divvy \
      /etc/nginx/snippets/erp-proxy.conf /etc/nginx/snippets/onrol-nocache.conf
sed -i 's#/etc/letsencrypt/live/erp\.187-127-178-100\.sslip\.io/#/etc/letsencrypt/live/temperp.187-127-178-100.sslip.io/#g' \
      /etc/nginx/sites-available/00-default
nginx -t && systemctl reload nginx

echo "== stale webroot copies and dead cron"
rm -rf /var/www/temperp-new /var/www/temperp-backup-081443 /var/www/temperp-backup-prev
rm -f /etc/cron.d/onrol-backup

echo "== certificates for hostnames that no longer have a site"
for n in accounts ambassador app calls college crm divvy edu erp franchise lms vivencia; do
  certbot delete --cert-name "$n.187-127-178-100.sslip.io" --non-interactive 2>/dev/null || true
done

echo "== caches and logs"
go clean -cache 2>/dev/null || rm -rf /root/.cache/go-build
rm -rf /root/.cache/uv /root/.cache/pip /root/.cache/prisma /root/.cache/code-server /root/.npm/_cacache
apt-get clean
journalctl --vacuum-size=100M
rm -f /var/log/*.1 /var/log/*.gz
find /tmp -maxdepth 1 -type f \( -name '*.sql' -o -name '*.out' -o -name '*.csv' -o -name '*.apk' -o -name '*.py' -o -name '*.sh' -o -name '*.conf' \) -delete

echo "== result"
df -h / | tail -1
systemctl list-units --type=service --state=running --no-pager | grep -E "temperp|ragbot|nginx|postgres|redis|ollama"
curl -fsS -o /dev/null -w "temperp https: %{http_code}\n" https://temperp.187-127-178-100.sslip.io/healthz
