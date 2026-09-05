#!/usr/bin/env bash
# Deploy the School ERP to Cloud Run (asia-south1).
#
# The Cloud Run counterpart of scripts/build-on-server.sh: build one image
# from a named commit, migrate, then swap the services. Same rules as the VPS
# deploy (README, "Deploy rules"): the deploy names a commit, migrations run
# before the binaries swap, and a failed step leaves the previous revision
# serving.
#
# Idempotent. Every gcloud call here is a replace-or-create; re-running with
# the same commit rebuilds the same tag and re-applies identical manifests,
# and Cloud Run only cuts a new revision when something actually changed.
#
#   bash deploy/cloudrun/deploy.sh                  # build HEAD, migrate, deploy web
#   bash deploy/cloudrun/deploy.sh --scheduler      # ...and (re)create the cron tick
#   bash deploy/cloudrun/deploy.sh --with-worker    # ...and the PAID always-on worker
#   bash deploy/cloudrun/deploy.sh --dry-run        # print every command, run none
#   SEED_ROLES=1 bash deploy/cloudrun/deploy.sh     # also reseed roles (see job-migrate.yaml)
#
# What is deployed by default is one service, temperp-web, which also works
# the queue (QUEUE_INPROCESS=1). Cron is Cloud Scheduler calling its
# /api/v1/cron every minute with X-Cron-Key; --scheduler creates or updates
# that job and is needed once per project and again whenever CRON_KEY or the
# service URL changes (it is idempotent, so passing it every time is fine).
# The worker service costs ~₹4,000/month and is only for push notifications
# or a job that must not share CPU with requests -- service-worker.yaml.
#
# Needs: gcloud authenticated against PROJECT_ID, the secrets created by
# secrets.sh, and deploy/cloudrun/.env.cloudrun (gitignored) holding the plain
# configuration values substituted into the manifests. --scheduler also needs
# the Cloud Scheduler API enabled (gcloud services enable
# cloudscheduler.googleapis.com) and CRON_KEY in the env file. Never run this
# against the VPS; it does not know the VPS exists.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env.cloudrun}"

DRY_RUN=0
WITH_WORKER=0
SCHEDULER=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --with-worker) WITH_WORKER=1 ;;
        --scheduler) SCHEDULER=1 ;;
        -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

# The env file carries PROJECT_ID and the plain (non-secret) values the
# manifests need. Sourced rather than parsed so a value with an '=' in it
# survives; it is our own file, written by hand, so `source` is safe.
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
elif [ "$DRY_RUN" = "1" ]; then
    echo "note: $ENV_FILE not found; dry run continues with placeholders" >&2
else
    echo "missing $ENV_FILE -- copy the template from docs/hosting-cloud-run.md" >&2
    exit 1
fi

PROJECT_ID="${PROJECT_ID:-PROJECT_ID}"
REGION="${REGION:-asia-south1}"
REPO="${REPO:-temperp}"
# The commit is the deploy's name. Short hash, same as build-on-server.sh, so
# the tag on the image, the label on the revision and the hash printed at the
# end are the same string a person can read out over the phone.
COMMIT="${COMMIT:-$(git -C "$ROOT" rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/app:${COMMIT}"

# Plain values for the manifests, defaults matching what the VPS runs with.
BASE_URL="${BASE_URL:-https://erp.example.school}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-REPLACE_ME}"
R2_BUCKET="${R2_BUCKET:-temperp}"
R2_PUBLIC_HOST="${R2_PUBLIC_HOST:-}"

say() { printf '\n=== %s ===\n' "$1"; }

# Every state-changing command goes through run(), so --dry-run is the same
# script with the doing switched off -- not a second script that drifts.
run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '+'; printf ' %q' "$@"; printf '\n'
    else
        "$@"
    fi
}

# Refuse to ship uncommitted work, as build-on-server.sh does by building from
# git: an image tagged with a commit hash that does not contain what was in
# the working tree is a rollback nobody can perform.
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    if [ "$DRY_RUN" = "1" ]; then
        echo "warning: working tree has uncommitted changes; a real run would refuse" >&2
    else
        echo "working tree has uncommitted changes; commit them or set ALLOW_DIRTY=1" >&2
        exit 1
    fi
fi

# The Scheduler job carries CRON_KEY as a header, so it needs the value, and
# needs it before anything is built: a deploy that fails at the last step
# over a missing key has already cut a revision.
if [ "$SCHEDULER" = "1" ] && [ -z "${CRON_KEY:-}" ] && [ "$DRY_RUN" != "1" ]; then
    echo "--scheduler needs CRON_KEY in $ENV_FILE (the same value secrets.sh uploaded)" >&2
    exit 1
fi

say "Target"
echo "  project  $PROJECT_ID"
echo "  region   $REGION"
echo "  image    $IMAGE"
echo "  base url $BASE_URL"
echo "  worker   $([ "$WITH_WORKER" = "1" ] && echo 'yes (paid, always-on)' || echo 'no (jobs run in temperp-web)')"
echo "  cron     $([ "$SCHEDULER" = "1" ] && echo 'Cloud Scheduler job will be created/updated' || echo 'left as is (pass --scheduler)')"
[ "$DRY_RUN" = "1" ] && echo "  (dry run: nothing will be executed)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/temperp-cloudrun.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT

say "Artifact Registry"
# Created on first run so a fresh project needs no console clicking. describe
# is the cheap idempotency check; create is only reached when it fails.
if [ "$DRY_RUN" = "1" ]; then
    echo "+ gcloud artifacts repositories describe $REPO --project $PROJECT_ID --location $REGION  (create if missing)"
elif ! gcloud artifacts repositories describe "$REPO" \
        --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$REPO" \
        --project "$PROJECT_ID" --location "$REGION" \
        --repository-format docker \
        --description "School ERP images (deploy/cloudrun)"
else
    echo "  $REPO exists"
fi

say "Build $COMMIT"
# `gcloud builds submit --tag` insists the Dockerfile sit at the root of the
# upload, and ours lives in deploy/cloudrun/ so the repo root stays honest
# about being a Go module. A one-step Cloud Build config says which Dockerfile
# to use against the whole tree as context. Written here rather than
# committed so the image name and commit are substituted, not hand-edited.
cat > "$TMP/cloudbuild.yaml" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --file=deploy/cloudrun/Dockerfile
      - --build-arg=COMMIT=\${_COMMIT}
      - --tag=\${_IMAGE}
      - .
images:
  - \${_IMAGE}
options:
  logging: CLOUD_LOGGING_ONLY
YAML
# The upload honours .gcloudignore, falling back to .gitignore, so node_modules
# and dist stay local. deployed-snapshot/ (the recovered binaries) is tracked
# and will be uploaded; add a .gcloudignore if that starts to hurt.
run gcloud builds submit "$ROOT" \
    --project "$PROJECT_ID" --region "$REGION" \
    --config "$TMP/cloudbuild.yaml" \
    --substitutions "_IMAGE=${IMAGE},_COMMIT=${COMMIT}"

say "Manifests"
# The committed manifests carry placeholders; the copies in $TMP carry values.
# sed on tokens rather than envsubst so a manifest that mentions \$PORT or any
# other literal dollar sign is left alone.
render() {
    sed -e "s|PROJECT_ID|${PROJECT_ID}|g" \
        -e "s|:COMMIT$|:${COMMIT}|" \
        -e "s|BASE_URL_VALUE|${BASE_URL}|g" \
        -e "s|R2_ACCOUNT_ID_VALUE|${R2_ACCOUNT_ID}|g" \
        -e "s|R2_BUCKET_VALUE|${R2_BUCKET}|g" \
        -e "s|R2_PUBLIC_HOST_VALUE|${R2_PUBLIC_HOST}|g" \
        "$HERE/$1" > "$TMP/$1"
    # A token that survived means the env file is missing a value; refuse
    # rather than hand Cloud Run a manifest with PROJECT_ID in the image path.
    # Except on a dry run without an env file, where surviving tokens are the
    # point of the exercise.
    if grep -qE "PROJECT_ID|:COMMIT$|_VALUE\b" "$TMP/$1"; then
        if [ "$DRY_RUN" = "1" ]; then
            echo "  rendered $1 (placeholders remain; dry run)"
            return 0
        fi
        echo "  !! $1 still has an unsubstituted placeholder:" >&2
        grep -nE "PROJECT_ID|:COMMIT$|_VALUE\b" "$TMP/$1" >&2
        exit 1
    fi
    echo "  rendered $1"
}
render job-migrate.yaml
render service-web.yaml
[ "$WITH_WORKER" = "1" ] && render service-worker.yaml

say "Migrate"
# Job first, then two executions, each waited on. `up` is the schema;
# `seed-permissions` is the additive half of seeding that every VPS deploy
# runs. Full `seed` rewrites role grants and is opt-in -- job-migrate.yaml
# says why. --wait makes a failed migration a failed deploy: nothing below
# this line runs if the schema is not where the new binaries expect it, and
# `services replace` -- the only step that moves traffic -- comes after, so
# the revision that receives traffic is the one whose migrations succeeded,
# and the old revision serves throughout (a River or schema change lands in
# the table before any binary that reads it starts). The job image is the
# new commit, exactly as build-on-server.sh migrates with the new binary.
run gcloud run jobs replace "$TMP/job-migrate.yaml" \
    --project "$PROJECT_ID" --region "$REGION"
run gcloud run jobs execute temperp-migrate \
    --project "$PROJECT_ID" --region "$REGION" --wait --args=up
if [ "${SEED_ROLES:-0}" = "1" ]; then
    echo "  SEED_ROLES=1: reseeding roles and catalogue grants"
    run gcloud run jobs execute temperp-migrate \
        --project "$PROJECT_ID" --region "$REGION" --wait --args=seed
fi
run gcloud run jobs execute temperp-migrate \
    --project "$PROJECT_ID" --region "$REGION" --wait --args=seed-permissions

say "Services"
# The optional worker before web, as the VPS restarts both together: a worker
# on the new schema must be consuming before the new web starts enqueueing
# jobs whose payloads the old worker would not understand. Without the flag
# the web service is the only consumer and there is no ordering to get right.
if [ "$WITH_WORKER" = "1" ]; then
    run gcloud run services replace "$TMP/service-worker.yaml" \
        --project "$PROJECT_ID" --region "$REGION"
else
    echo "  temperp-worker not deployed (jobs run inside temperp-web; --with-worker to change)"
fi
run gcloud run services replace "$TMP/service-web.yaml" \
    --project "$PROJECT_ID" --region "$REGION"

say "Health"
URL="https://temperp-web-PLACEHOLDER-el.a.run.app"
if [ "$DRY_RUN" = "1" ]; then
    echo "+ gcloud run services describe temperp-web --project $PROJECT_ID --region $REGION --format 'value(status.url)'"
    echo "+ curl -fsS \$URL/healthz"
else
    URL="$(gcloud run services describe temperp-web \
        --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
    echo "  $URL"
    # /healthz pings Postgres, so a 200 here means the revision is up AND can
    # reach Neon with the app role -- the two things most likely to be wrong
    # on a first deploy. Retried because the first request after a replace
    # is the cold start.
    for attempt in 1 2 3 4 5 6; do
        if body="$(curl -fsS --max-time 20 "$URL/healthz" 2>/dev/null)"; then
            echo "  healthz: $body"
            break
        fi
        if [ "$attempt" = "6" ]; then
            echo "  !! $URL/healthz did not answer 200 after six tries" >&2
            echo "  !! read: gcloud run services logs read temperp-web --project $PROJECT_ID --region $REGION" >&2
            exit 1
        fi
        sleep 5
    done
fi

say "Cron"
# Cloud Scheduler is the clock; the schedule itself lives in Postgres
# (internal/queue/cron.go) and this job only asks "anything due?" once a
# minute. The request goes to the run.app URL, not the Pages host: the Pages
# Function refuses /api/v1/cron (web/functions/[[path]].ts), and there is no
# reason for a tick to cross Cloudflare. Authentication is the X-Cron-Key
# header rather than OIDC because the service is public (ingress all, no IAM
# invoker check), so an OIDC token would be minted and never verified; the
# Go handler compares the key in constant time and 401s everything else.
#
# Every minute because the finest entry in the schedule (message_dispatch)
# is every minute; a tick that finds nothing due is one indexed query under
# an advisory lock. --attempt-deadline 60s so a slow tick is abandoned
# before the next one, and retries are off: the next minute IS the retry,
# and two ticks racing serialise on the lock anyway.
#
# The header value is the secret, and `gcloud scheduler jobs describe` shows
# it to anyone with roles/cloudscheduler.viewer -- the same people who can
# read the manifest's secret refs, so nothing new is exposed, but do not
# paste describe output into a ticket.
SCHED_JOB="${SCHED_JOB:-temperp-cron}"
SCHED_LOCATION="${SCHED_LOCATION:-$REGION}"
if [ "$SCHEDULER" = "1" ]; then
    cron_args=(
        --project "$PROJECT_ID" --location "$SCHED_LOCATION"
        --schedule "* * * * *" --time-zone "Asia/Kolkata"
        --uri "${URL}/api/v1/cron" --http-method GET
        --attempt-deadline 60s
        --max-retry-attempts 0
        --description "Ticks the ERP schedule (internal/queue/cron.go); created by deploy/cloudrun/deploy.sh"
    )
    # The header flag differs between the two verbs: create takes --headers,
    # update takes --update-headers (and would reject --headers).
    cron_header="X-Cron-Key=${CRON_KEY:-CRON_KEY_VALUE}"
    if [ "$DRY_RUN" = "1" ]; then
        echo "+ gcloud scheduler jobs describe $SCHED_JOB --project $PROJECT_ID --location $SCHED_LOCATION  (update if present, else create)"
        # The key is redacted here and only here: a dry run is what gets pasted around.
        printf '+ gcloud scheduler jobs create|update http %s' "$SCHED_JOB"
        printf ' %q' "${cron_args[@]}"
        printf ' %q\n' "--headers|--update-headers X-Cron-Key=<CRON_KEY>"
    elif gcloud scheduler jobs describe "$SCHED_JOB" \
            --project "$PROJECT_ID" --location "$SCHED_LOCATION" >/dev/null 2>&1; then
        gcloud scheduler jobs update http "$SCHED_JOB" "${cron_args[@]}" --update-headers "$cron_header" >/dev/null
        echo "  updated $SCHED_JOB -> ${URL}/api/v1/cron every minute"
    else
        gcloud scheduler jobs create http "$SCHED_JOB" "${cron_args[@]}" --headers "$cron_header" >/dev/null
        echo "  created $SCHED_JOB -> ${URL}/api/v1/cron every minute"
    fi
    if [ "$DRY_RUN" != "1" ]; then
        # Fire one now rather than wait a minute, and read the answer: a 200
        # with counts proves the key matches and the queue is reachable, which
        # is the whole point of the endpoint. Only the run.app URL is asked;
        # the Pages host would 404 by design.
        gcloud scheduler jobs run "$SCHED_JOB" --project "$PROJECT_ID" --location "$SCHED_LOCATION" >/dev/null || true
        if body="$(curl -fsS --max-time 30 -H "X-Cron-Key: ${CRON_KEY}" "$URL/api/v1/cron" 2>/dev/null)"; then
            echo "  cron tick: $body"
        else
            echo "  !! $URL/api/v1/cron did not answer 200 with the key from $ENV_FILE" >&2
            echo "  !! is temperp-cron-key in Secret Manager the same value? (secrets.sh)" >&2
            exit 1
        fi
    fi
else
    echo "  Cloud Scheduler job untouched; without one the schedule never runs (pass --scheduler)"
fi

say "Deployed $COMMIT"
