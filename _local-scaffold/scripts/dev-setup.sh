#!/usr/bin/env bash
#
# Creates the local development database and the application role.
#
# The application deliberately does NOT connect as the database owner. Postgres
# lets an owner (and any superuser) bypass row-level security, so running the app
# as the owner would leave every tenant-isolation policy in the schema switched
# off without a single error message. This script creates a plain, unprivileged
# role for the app; migrations run as the owner and grant it exactly what it
# needs.
#
# Usage:  scripts/dev-setup.sh [--reset]
set -euo pipefail

DB_NAME="${DB_NAME:-schoolerp}"
DB_APP_ROLE="${DB_APP_ROLE:-schoolerp_app}"
DB_APP_PASSWORD="${DB_APP_PASSWORD:-schoolerp_dev_password}"
# Default to the Unix socket: local superuser access is usually peer-authenticated,
# so this works without a password. The application itself connects over TCP as
# the unprivileged role.
ADMIN_CONN="${ADMIN_CONN:-postgres:///postgres?host=/var/run/postgresql}"

psql_admin() { psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 "$ADMIN_CONN" "$@"; }

if [[ "${1:-}" == "--reset" ]]; then
    echo "Dropping database ${DB_NAME}"
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)"
fi

if [[ -z "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP_ROLE}'")" ]]; then
    echo "Creating role ${DB_APP_ROLE}"
    psql_admin -c "CREATE ROLE ${DB_APP_ROLE} LOGIN PASSWORD '${DB_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE"
else
    echo "Role ${DB_APP_ROLE} already exists"
fi

if [[ -z "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")" ]]; then
    echo "Creating database ${DB_NAME}"
    psql_admin -c "CREATE DATABASE ${DB_NAME}"
else
    echo "Database ${DB_NAME} already exists"
fi

# CONNECT is not enough on its own: PUBLIC has CREATE on the public schema in
# older versions, and we want the app role to own nothing.
psql_admin -c "GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_APP_ROLE}"

echo
echo "Ready. Next:"
echo "  go run ./cmd/api migrate    # apply the schema"
echo "  go run ./cmd/api seed       # load development data"
echo "  go run ./cmd/api serve      # start the API"
