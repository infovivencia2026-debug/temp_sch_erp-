#!/usr/bin/env bash
# Put the ERP's secrets into Secret Manager and let the Cloud Run runtime
# service account read them.
#
# The VPS keeps secrets in /etc/temperp.env, written once by scripts/deploy.sh
# and preserved forever after. Cloud Run has no /etc; the equivalent is one
# Secret Manager secret per variable, referenced by name from the manifests
# (deploy/cloudrun/*.yaml) so no value is ever committed. This script is the
# single writer for those secrets.
#
# Source of values: deploy/cloudrun/.env.cloudrun, gitignored, KEY=value per
# line. It holds the plain settings too (PROJECT_ID, BASE_URL, R2_BUCKET...),
# which deploy.sh reads; only the keys listed in SECRET_KEYS below become
# secrets. Anything else is left in the file and ignored here.
#
# Idempotent. A secret is created if missing, and a new version is added only
# when the value actually changed -- otherwise every run would mint a version
# and the "latest" the services resolve at start-up would churn for nothing.
#
#   bash deploy/cloudrun/secrets.sh              # create/update from .env.cloudrun
#   bash deploy/cloudrun/secrets.sh --dry-run    # show what would change
#
# The one value to be careful with is PASSWORD_PEPPER. It must be the SAME
# string the VPS has in /etc/temperp.env, because it is folded into every
# stored password hash: a fresh pepper on Cloud Run would lock every user out
# of a database that was copied over intact. Copy it; never generate it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env.cloudrun}"
REGION="${REGION:-asia-south1}"

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see docs/hosting-cloud-run.md for the template)" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${PROJECT_ID:?PROJECT_ID must be set in $ENV_FILE}"

# The runtime identity for web, the migrate job and the optional worker. A dedicated
# account rather than the project's default compute account, which carries
# Editor on everything; this one can read these secrets and nothing else.
SA_NAME="${SA_NAME:-temperp-run}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Required secrets: config.Load refuses to start without the first four. There
# is no Redis URL: the queue is River, in the Postgres DATABASE_URL names, and
# the binaries ignore REDIS_URL if set. CRON_KEY is required because without
# it /api/v1/cron answers 401 to everyone and no schedule ever runs -- a
# deployment with no cron is a deployment that sends no reminders, and that
# should fail here, loudly, not in a month. The optional ones are
# uploaded only when the env file has a non-empty value, because a manifest
# that references a secret which does not exist fails to deploy -- so the
# manifests reference only the required set plus the ones committed as always
# present (PAYMENT_GATEWAY_SECRET, the R2 keys), and those must be given even
# if, like PAYMENT_GATEWAY_SECRET before Razorpay is wired, the value is a
# placeholder the app falls back from.
SECRET_KEYS=(
    DATABASE_URL
    MIGRATE_DATABASE_URL
    CRON_KEY
    SESSION_SECRET
    PASSWORD_PEPPER
    CREDENTIAL_KEY
    PAYMENT_GATEWAY_SECRET
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
)
# Read directly with os.Getenv outside internal/config, or consumed as a file:
# uploaded when present, referenced from a manifest only once you uncomment
# the matching block (service-worker.yaml for FCM, service-web.yaml for
# ORIGIN_SHARED_SECRET, which must also be set on the Pages project).
OPTIONAL_KEYS=(
    ORIGIN_SHARED_SECRET
    ANTHROPIC_API_KEY
    FCM_SERVICE_ACCOUNT_JSON
)

# Secret Manager ids allow [A-Za-z0-9_-]; lower-case hyphenated names match
# what the manifests reference: DATABASE_URL -> temperp-database-url.
secret_id() { printf 'temperp-%s' "$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')"; }

run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '+'; printf ' %q' "$@"; printf '\n'
    else
        "$@"
    fi
}

say() { printf '\n=== %s ===\n' "$1"; }

say "Service account $SA_EMAIL"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$SA_NAME" \
        --project "$PROJECT_ID" \
        --display-name "School ERP Cloud Run runtime"
else
    echo "  exists"
fi

# upsert NAME VALUE: create the secret if needed, add a version if the value
# differs from the current latest, and grant the runtime account access.
# Values travel through stdin (--data-file=-), never argv, so they do not
# appear in `ps` or in the shell history of the operator's machine.
upsert() {
    local key="$1" value="$2" id
    id="$(secret_id "$key")"
    if ! gcloud secrets describe "$id" --project "$PROJECT_ID" >/dev/null 2>&1; then
        # Replication pinned to the region the services run in: these are a
        # school's children's records' keys, and there is no reason for them
        # to be replicated to every Google region by default.
        run gcloud secrets create "$id" \
            --project "$PROJECT_ID" \
            --replication-policy user-managed --locations "$REGION"
        echo "  created  $id"
    fi
    local current=""
    if [ "$DRY_RUN" != "1" ]; then
        current="$(gcloud secrets versions access latest --secret "$id" --project "$PROJECT_ID" 2>/dev/null || true)"
    fi
    if [ "$current" = "$value" ]; then
        echo "  unchanged $id"
    elif [ "$DRY_RUN" = "1" ]; then
        echo "+ printf '%s' \"\$$key\" | gcloud secrets versions add $id --project $PROJECT_ID --data-file=-"
    else
        printf '%s' "$value" | gcloud secrets versions add "$id" \
            --project "$PROJECT_ID" --data-file=- >/dev/null
        echo "  updated  $id"
    fi
    # Per-secret rather than project-wide secretAccessor: the same project
    # may one day hold another service's secrets, and the ERP's identity
    # should be able to read exactly its own.
    run gcloud secrets add-iam-policy-binding "$id" \
        --project "$PROJECT_ID" \
        --member "serviceAccount:${SA_EMAIL}" \
        --role roles/secretmanager.secretAccessor >/dev/null
}

say "Required secrets"
missing=0
for key in "${SECRET_KEYS[@]}"; do
    value="${!key:-}"
    if [ -z "$value" ]; then
        echo "  !! $key is empty in $ENV_FILE" >&2
        missing=1
        continue
    fi
    upsert "$key" "$value"
done
[ "$missing" = "0" ] || { echo "fill in the missing keys and re-run" >&2; exit 1; }

say "Optional secrets"
for key in "${OPTIONAL_KEYS[@]}"; do
    value="${!key:-}"
    if [ -z "$value" ]; then
        echo "  skipped  $key (not set)"
        continue
    fi
    upsert "$key" "$value"
done

# Sanity checks that catch the two mistakes a first cut-over is most likely
# to make. Warnings, not failures: the operator may know better.
say "Checks"
case "${DATABASE_URL:-}" in
    *sslmode=require*|*sslmode=verify-full*) echo "  DATABASE_URL has sslmode -- good" ;;
    *) echo "  warning: DATABASE_URL lacks sslmode=require; Neon refuses plaintext" ;;
esac
if [ -n "${REDIS_URL:-}" ]; then
    echo "  note: REDIS_URL is set; the queue is in Postgres (River) and the app ignores it"
fi
# The cron key is compared in constant time against a header on a public
# endpoint; a short one is guessable and the worst case is somebody running
# the housekeeping early, all day. Generate it, never type it:
#   CRON_KEY=$(openssl rand -hex 32)
if [ "${#CRON_KEY}" -lt 32 ]; then
    echo "  warning: CRON_KEY is shorter than 32 characters; use openssl rand -hex 32"
fi
if [ -n "${ORIGIN_SHARED_SECRET:-}" ] && [ "${#ORIGIN_SHARED_SECRET}" -lt 32 ]; then
    echo "  warning: ORIGIN_SHARED_SECRET is shorter than 32 characters; use openssl rand -hex 32"
fi
if [ "${PASSWORD_PEPPER:-}" = "REPLACE_ME" ]; then
    echo "  warning: PASSWORD_PEPPER is a placeholder; copy the VPS value or nobody can sign in"
fi

say "Done"
echo "  runtime identity: $SA_EMAIL"
echo "  next: bash deploy/cloudrun/deploy.sh --dry-run"
