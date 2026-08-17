#!/usr/bin/env bash
# Installs the School ERP onto srv1738656 as native systemd services against
# the Postgres 16 already on the box. Run after wipe-apps.sh.
#
# Binaries are cross-compiled on the operator's machine and uploaded, so no Go
# toolchain is installed here — this box has 1 vCPU and a nearly full disk.
#
# Idempotent: re-running upgrades the binaries and restarts the services
# without touching the database or regenerating secrets.

set -euo pipefail

APP_DIR=/opt/school-erp
ENV_FILE=/etc/school-erp.env
DB_NAME=school_erp
DB_OWNER=erp_owner
DB_APP_USER=app_user
HOSTNAME_FQDN=erp.187-127-178-100.sslip.io

say() { printf '\n=== %s ===\n' "$1"; }

say "Installing Redis"
if ! command -v redis-server >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq redis-server
fi
# Sessions and the job queue share this instance. noeviction because silently
# dropping a queued fee reminder is worse than an enqueue error.
sed -i 's/^# *maxmemory .*/maxmemory 256mb/; s/^# *maxmemory-policy .*/maxmemory-policy noeviction/' \
    /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || echo 'maxmemory 256mb' >> /etc/redis/redis.conf
grep -q '^maxmemory-policy ' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

say "Creating service user and directories"
id -u schoolerp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin schoolerp
install -d -o schoolerp -g schoolerp -m 0755 "$APP_DIR"
install -d -o schoolerp -g schoolerp -m 0750 /var/log/school-erp

say "Installing binaries"
install -o root -g root -m 0755 /tmp/school-erp-dist/web     "$APP_DIR/web"
install -o root -g root -m 0755 /tmp/school-erp-dist/worker  "$APP_DIR/worker"
install -o root -g root -m 0755 /tmp/school-erp-dist/migrate "$APP_DIR/migrate"

say "Provisioning database roles and database"
# Secrets are generated once and preserved across re-runs, since changing
# PASSWORD_PEPPER would invalidate every stored password.
if [ -f "$ENV_FILE" ]; then
    echo "  $ENV_FILE exists — keeping existing secrets"
    # shellcheck disable=SC1090
    set -a && source "$ENV_FILE" && set +a
    OWNER_PW="${POSTGRES_PASSWORD}"
    APP_PW="${APP_DB_PASSWORD}"
else
    OWNER_PW="$(openssl rand -hex 24)"
    APP_PW="$(openssl rand -hex 24)"
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_OWNER}') THEN
        CREATE ROLE ${DB_OWNER} LOGIN PASSWORD '${OWNER_PW}';
    ELSE
        ALTER ROLE ${DB_OWNER} PASSWORD '${OWNER_PW}';
    END IF;
    -- app_user is deliberately unprivileged. Postgres exempts superusers and
    -- table owners from RLS, so if the app connected as ${DB_OWNER} every
    -- tenant isolation policy would be silently bypassed.
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
REVOKE CREATE ON SCHEMA public FROM ${DB_APP_USER};
SQL

say "Writing ${ENV_FILE}"
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<ENV
# School ERP runtime configuration.
#
# The R2_* values below are placeholders. The web service will refuse to start
# until they are real — that is deliberate, so a half-configured deploy fails
# at boot rather than at the first file upload.

APP_ENV=production
HTTP_ADDR=127.0.0.1:8090
BASE_URL=https://${HOSTNAME_FQDN}

POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_OWNER}
POSTGRES_PASSWORD=${OWNER_PW}
APP_DB_USER=${DB_APP_USER}
APP_DB_PASSWORD=${APP_PW}

DATABASE_URL=postgres://${DB_APP_USER}:${APP_PW}@127.0.0.1:5432/${DB_NAME}?sslmode=disable
# 1 vCPU box shared with nginx and Redis; a large pool would just queue.
DB_MAX_CONNS=10

REDIS_URL=redis://127.0.0.1:6379/0

SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
SESSION_TTL=12h
SESSION_IDLE_TTL=2h
# Changing PASSWORD_PEPPER invalidates every password in the database.
PASSWORD_PEPPER=$(openssl rand -base64 48 | tr -d '\n')
CREDENTIAL_KEY=$(openssl rand -hex 16)

# --- FILL THESE IN -------------------------------------------------------
R2_ACCOUNT_ID=REPLACE_ME
R2_ACCESS_KEY_ID=REPLACE_ME
R2_SECRET_ACCESS_KEY=REPLACE_ME
# -------------------------------------------------------------------------
R2_BUCKET=school-erp
R2_PUBLIC_HOST=
R2_PRESIGN_EXPIRY=10m
ENV
    echo "  created with generated secrets and R2 placeholders"
else
    echo "  exists — left untouched"
fi
chown root:schoolerp "$ENV_FILE"
chmod 0640 "$ENV_FILE"

say "Running migrations"
# Migrations connect as the owner; the app connects as app_user.
DATABASE_URL="postgres://${DB_OWNER}:${OWNER_PW}@127.0.0.1:5432/${DB_NAME}?sslmode=disable" \
    "$APP_DIR/migrate" up

say "Installing systemd units"
install -m 0644 /tmp/school-erp-dist/school-erp-web.service    /etc/systemd/system/
install -m 0644 /tmp/school-erp-dist/school-erp-worker.service /etc/systemd/system/
systemctl daemon-reload

say "Configuring nginx"
install -m 0644 /tmp/school-erp-dist/nginx-school-erp.conf /etc/nginx/sites-available/school-erp
ln -sf /etc/nginx/sites-available/school-erp /etc/nginx/sites-enabled/school-erp
nginx -t
systemctl reload nginx

say "Done"
echo "Next: fill in the three R2_* values in ${ENV_FILE}, then"
echo "  systemctl enable --now school-erp-web school-erp-worker"
