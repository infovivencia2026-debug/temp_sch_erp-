#!/usr/bin/env bash
# Install/upgrade the School ERP as native systemd services.
#
# Runs ON the server, uploaded by `make deploy-app`. Binaries are cross-compiled
# on the operator's machine, so no Go or Node toolchain is installed here.
#
# Idempotent: re-running upgrades the binaries, re-applies migrations and
# restarts the services without touching data or regenerating secrets.
#
# Everything is namespaced by $SERVICE so this can live alongside another ERP
# deployment on the same box without colliding on ports, databases, unit names,
# nginx sites or webroots.

set -euo pipefail

SERVICE="${SERVICE:-temperp}"
FQDN="${FQDN:-temperp.187-127-178-100.sslip.io}"
APP_DIR="${APP_DIR:-/opt/${SERVICE}}"
WEBROOT="${WEBROOT:-/var/www/${SERVICE}}"
ENV_FILE="/etc/${SERVICE}.env"
DIST="/tmp/${SERVICE}-dist"

DB_NAME="${SERVICE}"
DB_OWNER="${SERVICE}_owner"
DB_APP_USER="${SERVICE}_app"
RUN_USER="${SERVICE}"

# Port is derived rather than fixed so a second deployment does not silently
# fight the first one for 8090.
HTTP_PORT="${HTTP_PORT:-8091}"
# Redis logical database, likewise separated from any neighbour.
REDIS_DB="${REDIS_DB:-1}"

say() { printf '\n=== %s ===\n' "$1"; }

say "Preflight"
for cmd in nginx psql redis-cli systemctl; do
    command -v "$cmd" >/dev/null || { echo "missing required command: $cmd" >&2; exit 1; }
done
if ss -ltn | grep -q "127.0.0.1:${HTTP_PORT} "; then
    # Only a problem if something *other* than our own service holds it.
    if ! systemctl is-active --quiet "${SERVICE}-web"; then
        echo "port ${HTTP_PORT} is already in use by another process" >&2
        exit 1
    fi
fi
echo "  ok"

say "Service user and directories"
id -u "$RUN_USER" >/dev/null 2>&1 || \
    useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "/var/log/${SERVICE}"
install -d -m 0755 "$WEBROOT"

say "Redis"
# Sessions and the job queue share the instance already on the box. noeviction
# matters: silently dropping a queued fee reminder is worse than a loud enqueue
# error, and the default policy would evict queue keys under memory pressure.
if ! redis-cli ping >/dev/null 2>&1; then
    echo "redis is not responding" >&2; exit 1
fi
current_policy="$(redis-cli config get maxmemory-policy | tail -1)"
if [ "$current_policy" != "noeviction" ]; then
    echo "  warning: maxmemory-policy is '${current_policy}', expected noeviction"
fi

say "Database roles and database"
if [ -f "$ENV_FILE" ]; then
    echo "  ${ENV_FILE} exists — preserving existing secrets"
    # shellcheck disable=SC1090
    set -a && source "$ENV_FILE" && set +a
    OWNER_PW="${POSTGRES_PASSWORD}"
    APP_PW="${APP_DB_PASSWORD}"
    SESSION_SECRET="${SESSION_SECRET}"
    PASSWORD_PEPPER="${PASSWORD_PEPPER}"
    CREDENTIAL_KEY="${CREDENTIAL_KEY}"
else
    OWNER_PW="$(openssl rand -hex 24)"
    APP_PW="$(openssl rand -hex 24)"
    SESSION_SECRET="$(openssl rand -base64 48)"
    # Rotating this invalidates every stored password, so it is generated once
    # and never rewritten.
    PASSWORD_PEPPER="$(openssl rand -base64 48)"
    CREDENTIAL_KEY="$(openssl rand -base64 32)"
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_OWNER}') THEN
        CREATE ROLE ${DB_OWNER} LOGIN PASSWORD '${OWNER_PW}';
    ELSE
        ALTER ROLE ${DB_OWNER} PASSWORD '${OWNER_PW}';
    END IF;
    -- The app connects as this role, never as the owner. Every tenant table
    -- uses FORCE ROW LEVEL SECURITY, so even the owner is subject to the
    -- policies -- but keeping the app unprivileged also denies it DDL.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_APP_USER}') THEN
        CREATE ROLE ${DB_APP_USER} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE ${DB_APP_USER} PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END \$\$;
SQL

if ! sudo -u postgres psql -lqtA | cut -d'|' -f1 | grep -qx "$DB_NAME"; then
    sudo -u postgres createdb -O "$DB_OWNER" "$DB_NAME"
    echo "  created database ${DB_NAME}"
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_APP_USER};
GRANT USAGE ON SCHEMA public TO ${DB_APP_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${DB_APP_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO ${DB_APP_USER};
-- No DDL for the app role.
REVOKE CREATE ON SCHEMA public FROM ${DB_APP_USER};
SQL

say "Writing ${ENV_FILE}"
umask 077
cat > "$ENV_FILE" <<ENV
# ${SERVICE} runtime configuration. Managed by deploy.sh -- secrets are
# generated once and preserved across re-runs.
APP_ENV=production
HTTP_ADDR=127.0.0.1:${HTTP_PORT}
BASE_URL=https://${FQDN}

POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_OWNER}
POSTGRES_PASSWORD=${OWNER_PW}
APP_DB_USER=${DB_APP_USER}
APP_DB_PASSWORD=${APP_PW}

# The app runs as the unprivileged role so RLS applies to it.
DATABASE_URL=postgres://${DB_APP_USER}:${APP_PW}@127.0.0.1:5432/${DB_NAME}?sslmode=disable
# Migrations need the owner, which the app role deliberately is not.
MIGRATE_DATABASE_URL=postgres://${DB_OWNER}:${OWNER_PW}@127.0.0.1:5432/${DB_NAME}?sslmode=disable
# 1 vCPU shared with nginx, Postgres and Redis; a large pool would just queue.
DB_MAX_CONNS=10

REDIS_URL=redis://127.0.0.1:6379/${REDIS_DB}

SESSION_SECRET=${SESSION_SECRET}
SESSION_TTL=12h
SESSION_IDLE_TTL=2h
# Changing PASSWORD_PEPPER invalidates every password in the database.
PASSWORD_PEPPER=${PASSWORD_PEPPER}
CREDENTIAL_KEY=${CREDENTIAL_KEY}

# --- Cloudflare R2: fill these in to enable uploads ------------------------
# Until they are real, /api/v1/files/presign returns 503 with an explicit
# reason. The service still starts -- an unconfigured bucket should not take
# the whole ERP down.
R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-REPLACE_ME}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID:-REPLACE_ME}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY:-REPLACE_ME}
R2_BUCKET=${R2_BUCKET:-${SERVICE}}
R2_PUBLIC_HOST=${R2_PUBLIC_HOST:-}
R2_PRESIGN_EXPIRY=10m
ENV
chown root:"$RUN_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
umask 022

say "Installing binaries"
install -o root -g root -m 0755 "$DIST/web"     "$APP_DIR/web"
install -o root -g root -m 0755 "$DIST/worker"  "$APP_DIR/worker"
install -o root -g root -m 0755 "$DIST/migrate" "$APP_DIR/migrate"

say "Applying migrations"
# Runs as the owner via MIGRATE_DATABASE_URL. Done before the restart so the
# new binary never sees a schema older than it expects.
( set -a; source "$ENV_FILE"; set +a; "$APP_DIR/migrate" up )
# Permission keys the new build references, so a role can be granted them.
# Purely additive; role grants stay manual because seeding one rewrites it.
( set -a; source "$ENV_FILE"; set +a; "$APP_DIR/migrate" seed-permissions )

say "systemd units"
write_unit() {
    local name="$1" desc="$2" exec="$3" extra="$4"
    cat > "/etc/systemd/system/${name}.service" <<UNIT
[Unit]
Description=${desc}
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${exec}
Restart=always
RestartSec=5s
${extra}

# The binaries embed their templates and static assets, so they need no write
# access to their own directory. Everything user-uploaded goes to R2.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/${SERVICE}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
}

write_unit "${SERVICE}-web" "${SERVICE} web server (Go)" "${APP_DIR}/web" ""
write_unit "${SERVICE}-worker" "${SERVICE} background worker (Go)" "${APP_DIR}/worker" ""

systemctl daemon-reload
systemctl enable "${SERVICE}-web" "${SERVICE}-worker" >/dev/null
systemctl restart "${SERVICE}-web" "${SERVICE}-worker"

say "nginx"
# If a certificate already exists, this script emits the TLS vhost itself.
#
# It must: the config below is rewritten from scratch on every deploy, which
# silently discarded the server block certbot had patched in, leaving no vhost
# listening on 443 for this hostname. Requests then fell through to whichever
# other TLS vhost nginx considered default and were served with the wrong
# certificate. Owning the TLS block here makes redeploys idempotent.
SSL_BLOCK=""
REDIRECT_BLOCK=""
if [ -d "/etc/letsencrypt/live/${FQDN}" ]; then
    SSL_BLOCK="listen 443 ssl;
    ssl_certificate     /etc/letsencrypt/live/${FQDN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${FQDN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    # Gate on scheme, not host: this one server block serves both 80 and 443,
    # so a host-only test also matches the TLS request and loops forever.
    REDIRECT_BLOCK="if (\$scheme = http) { return 301 https://\$host\$request_uri; }"
fi
# The SPA owns the root namespace; the Go service is reached on an explicit set
# of locations. Two subtleties, both learned the hard way on the sibling deploy:
#   * "location /admin" is a PREFIX match and would also swallow the SPA's
#     /admin-portal module. Exact + subtree is what you want.
#   * "location /assets/" would shadow the SPA's own /assets route. Vite bundle
#     files always carry an extension, so match on that instead.
cat > "/etc/nginx/sites-available/${SERVICE}" <<NGINX
server {
    listen 80;
    server_name ${FQDN};

    ${SSL_BLOCK}
    ${REDIRECT_BLOCK}

    root ${WEBROOT};
    index index.html;

    client_max_body_size 16m;

    access_log /var/log/nginx/${SERVICE}.access.log;
    error_log  /var/log/nginx/${SERVICE}.error.log;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    # ---- Go service -------------------------------------------------------
    location /api/    { include /etc/nginx/snippets/${SERVICE}-proxy.conf; }
    location /healthz { include /etc/nginx/snippets/${SERVICE}-proxy.conf; access_log off; }
    location /login   { include /etc/nginx/snippets/${SERVICE}-proxy.conf; }
    # The public pricing page is server-rendered, like sign-in: it has to work
    # before any tenant exists. Without this it falls through to the SPA below
    # and a buyer is shown an application they cannot sign in to.
    location = /buy   { include /etc/nginx/snippets/${SERVICE}-proxy.conf; }
    # Self-service purchase, likewise server-rendered and likewise needed
    # before the buyer has an account. A prefix match, not an exact one: the
    # flow continues into /signup/pay/{order} and /signup/welcome/{order}, and
    # an exact match would send a school that had just paid to the SPA shell.
    location /signup  { include /etc/nginx/snippets/${SERVICE}-proxy.conf; }
    location /logout  { include /etc/nginx/snippets/${SERVICE}-proxy.conf; }
    location /static/ { include /etc/nginx/snippets/${SERVICE}-proxy.conf; expires 7d; access_log off; }

    # ---- SPA --------------------------------------------------------------
    location ~ ^/assets/.+\.(js|css|map|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp)\$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location = /index.html {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # BrowserRouter: deep links such as /students/roster fall through here.
    location / {
        # The shell must always revalidate. A 'location = /index.html' block
        # does not cover this: a request for '/' is rewritten internally by
        # try_files and never enters an exact-match location, so without this
        # header browsers pin to a stale bundle after every deploy.
        add_header Cache-Control "no-cache, must-revalidate" always;
        try_files \$uri /index.html;  # no \$uri/ — it would 301 /assets to the real directory
    }

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX

install -d /etc/nginx/snippets
cat > "/etc/nginx/snippets/${SERVICE}-proxy.conf" <<PROXY
proxy_pass http://127.0.0.1:${HTTP_PORT};
proxy_http_version 1.1;
proxy_set_header Host              \$host;
proxy_set_header X-Real-IP         \$remote_addr;
proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_set_header X-Request-Id      \$request_id;
proxy_read_timeout 60s;
PROXY

ln -sfn "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
nginx -t
systemctl reload nginx

say "TLS"
if command -v certbot >/dev/null; then
    if [ ! -d "/etc/letsencrypt/live/${FQDN}" ]; then
        # webroot, not --nginx: the nginx plugin edits the site file, which
        # this script rewrites on every deploy. Issue the cert here, then
        # re-render the config so it picks up the TLS block above.
        certbot certonly --webroot -w /var/www/html -d "$FQDN" \
            --non-interactive --agree-tos --register-unsafely-without-email \
            && echo "  certificate issued — re-run deploy to enable TLS" \
            || echo "  certbot failed — the site is still reachable over http"
    else
        echo "  certificate already present"
    fi
else
    echo "  certbot not installed — skipping TLS"
fi

say "Health"
sleep 2
for i in 1 2 3 4 5; do
    if curl -fsS "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
        echo "  healthz ok"
        break
    fi
    [ "$i" = 5 ] && { echo "  healthz never came up"; journalctl -u "${SERVICE}-web" -n 30 --no-pager; exit 1; }
    sleep 2
done

systemctl --no-pager --lines=0 status "${SERVICE}-web" "${SERVICE}-worker" | grep -E 'Active:|●' || true
echo
echo "Deployed: https://${FQDN}"
echo "Next: ${APP_DIR}/migrate create-admin -institution 'Your School' -email you@example.com -password '...'"
