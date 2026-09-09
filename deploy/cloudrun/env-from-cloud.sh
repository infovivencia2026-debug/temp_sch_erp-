#!/usr/bin/env bash
# Rebuild deploy/cloudrun/.env.cloudrun from what is already in the cloud.
#
#   bash deploy/cloudrun/env-from-cloud.sh > deploy/cloudrun/.env.cloudrun
#   chmod 600 deploy/cloudrun/.env.cloudrun
#
# WHY THIS EXISTS. The env file holds the database URLs and the four secrets
# the service runs on, so it is gitignored and always will be. That left it on
# exactly one laptop: a second machine, or the same machine after a reinstall,
# could not deploy at all, and the answer was to copy secrets between computers
# by hand -- which is the worst way to move a password pepper that every stored
# hash depends on.
#
# It never needed copying. Every secret is already in Secret Manager, because
# that is where the running service reads them from, and every non-secret value
# is on the deployed service itself. So this reads both back and prints the
# file. Anyone with gcloud access to the project can deploy; nobody has to be
# sent a secret.
#
# It prints to stdout on purpose. A script that writes a file full of secrets
# is a script that can overwrite the good copy with a half-fetched one.
set -euo pipefail

PROJECT="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-temperp-web}"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] || {
    echo "no project: run 'gcloud config set project <id>' or pass PROJECT_ID=" >&2
    exit 1
}

secret() {
    gcloud secrets versions access latest --secret="$1" --project="$PROJECT" 2>/dev/null || {
        echo "could not read secret $1 -- has this account been granted secretAccessor?" >&2
        exit 1
    }
}

# The non-secret settings are read off the service rather than kept in a second
# place that can disagree with it.
svc_env() {
    gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
        --format="value(spec.template.spec.containers[0].env.filter(\"name:$1\").extract(value).flatten())" 2>/dev/null
}

BASE_URL="$(svc_env BASE_URL)"
R2_ACCOUNT_ID="$(svc_env R2_ACCOUNT_ID)"
R2_BUCKET="$(svc_env R2_BUCKET)"
R2_PUBLIC_HOST="$(svc_env R2_PUBLIC_HOST)"

cat <<EOF
# Rebuilt by deploy/cloudrun/env-from-cloud.sh on $(date -u +%Y-%m-%dT%H:%MZ).
# Every value came from Secret Manager or from the deployed service; nothing
# here was typed. Gitignored, and it stays that way.
PROJECT_ID=$PROJECT
REGION=$REGION
BASE_URL=$BASE_URL
R2_ACCOUNT_ID=$R2_ACCOUNT_ID
R2_BUCKET=$R2_BUCKET
R2_PUBLIC_HOST=$R2_PUBLIC_HOST
R2_ACCESS_KEY_ID=$(secret temperp-r2-access-key-id)
R2_SECRET_ACCESS_KEY=$(secret temperp-r2-secret-access-key)
DATABASE_URL=$(secret temperp-database-url)
MIGRATE_DATABASE_URL=$(secret temperp-migrate-database-url)
SESSION_SECRET=$(secret temperp-session-secret)
PASSWORD_PEPPER=$(secret temperp-password-pepper)
CREDENTIAL_KEY=$(secret temperp-credential-key)
PAYMENT_GATEWAY_SECRET=$(secret temperp-payment-gateway-secret)
CRON_KEY=$(secret temperp-cron-key)
ORIGIN_SHARED_SECRET=$(secret temperp-origin-shared-secret)
EOF
