#!/usr/bin/env bash
# One-time: let GitHub Actions deploy to Cloud Run without a key.
#
#   gcloud auth login && gcloud config set project project-2a0e3e6a-308a-4484-9cb
#   bash deploy/cloudrun/wif-setup.sh              # create, bind, print the two values
#   bash deploy/cloudrun/wif-setup.sh --dry-run    # print every command, run none
#
# WHY THIS EXISTS. Every deploy so far has been a person at a laptop with
# `gcloud auth login`, and the organisation's Secure-by-Default policy forbids
# service-account JSON keys, so a CI deploy could not simply be handed a key
# (docs/hosting-cloud-run.md, "No service-account keys"). Workload Identity
# Federation is the way that policy intends: GitHub's own OIDC token for a
# workflow run is exchanged, at Google, for a short-lived token of a service
# account that this script creates -- nothing to copy, nothing to rotate,
# nothing that leaks. .github/workflows/deploy-cloudrun.yml uses it.
#
# WHAT IT CREATES, all idempotent (each step is describe-then-create):
#   - a service account, temperp-deployer, holding exactly the roles
#     deploy.sh needs and no key;
#   - a workload identity pool `github` with an OIDC provider `temperp` that
#     trusts token.actions.githubusercontent.com ONLY for this repository
#     (attribute condition), so a fork or another repo in the account cannot
#     assume the deployer;
#   - the binding that lets that repository's workflows impersonate the
#     deployer, and the binding that lets the deployer act as the runtime
#     account (temperp-run), which `gcloud run services replace` requires.
#
# It ends by printing the two values the workflow needs as repository
# secrets. Neither is secret in the cryptographic sense -- a provider name
# and an email -- but they are kept as secrets so a fork's workflow log does
# not advertise the project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ] || {
    echo "no project: run 'gcloud config set project <id>' or pass PROJECT_ID=" >&2
    exit 1
}
REPO_SLUG="${REPO_SLUG:-infovivencia2026-debug/temp_sch_erp-}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-temperp}"
DEPLOYER="${DEPLOYER:-temperp-deployer}"
RUNTIME="${RUNTIME:-temperp-run}"

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

say() { printf '\n=== %s ===\n' "$1"; }
run() {
    if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_EMAIL="${RUNTIME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
PROVIDER_PATH="${POOL_PATH}/providers/${PROVIDER}"

say "Target"
echo "  project    $PROJECT_ID ($PROJECT_NUMBER)"
echo "  repository $REPO_SLUG"
echo "  deployer   $DEPLOYER_EMAIL"
echo "  provider   $PROVIDER_PATH"

say "APIs"
run gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
    --project "$PROJECT_ID"

say "Deployer service account"
if gcloud iam service-accounts describe "$DEPLOYER_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "  exists"
else
    run gcloud iam service-accounts create "$DEPLOYER" --project "$PROJECT_ID" \
        --display-name "GitHub Actions deployer (deploy/cloudrun/deploy.sh)"
fi

# The roles deploy.sh and env-from-cloud.sh exercise, and nothing wider:
#   run.admin                    jobs replace/execute, services replace
#   cloudbuild.builds.editor     gcloud builds submit
#   storage.admin                the *_cloudbuild source bucket that submit
#                                uploads to (objects create/list on it)
#   artifactregistry.writer      pushing the image
#   secretmanager.secretAccessor env-from-cloud.sh reads the secrets back
#   cloudscheduler.admin         --scheduler upserts the two cron jobs
#   serviceusage.serviceUsageConsumer
#                                quota project for the builds/API calls
say "Project roles"
for role in roles/run.admin roles/cloudbuild.builds.editor roles/storage.admin \
            roles/artifactregistry.writer roles/secretmanager.secretAccessor \
            roles/cloudscheduler.admin roles/serviceusage.serviceUsageConsumer; do
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member "serviceAccount:${DEPLOYER_EMAIL}" --role "$role" \
        --condition None --quiet >/dev/null
    echo "  $role"
done

# `services replace` sets serviceAccountName: temperp-run, which needs the
# caller to hold actAs on that account; and Cloud Build runs its steps as
# the project's default build account, which submit must be able to use.
say "Act-as bindings"
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${DEPLOYER_EMAIL}" --role roles/iam.serviceAccountUser --quiet >/dev/null
echo "  $DEPLOYER -> actAs $RUNTIME"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
if gcloud iam service-accounts describe "$COMPUTE_SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" \
        --project "$PROJECT_ID" \
        --member "serviceAccount:${DEPLOYER_EMAIL}" --role roles/iam.serviceAccountUser --quiet >/dev/null
    echo "  $DEPLOYER -> actAs the default build account"
fi

say "Workload identity pool and provider"
if gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location global >/dev/null 2>&1; then
    echo "  pool $POOL exists"
else
    run gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" \
        --location global --display-name "GitHub Actions"
fi
# The attribute condition is the whole security of this: without it any
# GitHub repository on earth could mint a token that this pool accepts.
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" \
        --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then
    echo "  provider $PROVIDER exists"
    run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --project "$PROJECT_ID" \
        --location global --workload-identity-pool "$POOL" \
        --attribute-condition "assertion.repository == '${REPO_SLUG}'"
else
    run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT_ID" \
        --location global --workload-identity-pool "$POOL" \
        --display-name "GitHub: ${REPO_SLUG}" \
        --issuer-uri "https://token.actions.githubusercontent.com" \
        --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
        --attribute-condition "assertion.repository == '${REPO_SLUG}'"
fi

say "Let the repository's workflows become the deployer"
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
    --project "$PROJECT_ID" \
    --role roles/iam.workloadIdentityUser \
    --member "principalSet://iam.googleapis.com/${POOL_PATH}/attribute.repository/${REPO_SLUG}" \
    --quiet >/dev/null
echo "  bound"

say "Repository secrets"
echo "  Settings -> Secrets and variables -> Actions -> New repository secret:"
echo
echo "    GCP_PROJECT_ID          $PROJECT_ID"
echo "    GCP_WIF_PROVIDER        $PROVIDER_PATH"
echo "    GCP_DEPLOYER_SA         $DEPLOYER_EMAIL"
echo
echo "  or, with the GitHub CLI signed in to the repository:"
echo "    gh secret set GCP_PROJECT_ID   --repo $REPO_SLUG --body '$PROJECT_ID'"
echo "    gh secret set GCP_WIF_PROVIDER --repo $REPO_SLUG --body '$PROVIDER_PATH'"
echo "    gh secret set GCP_DEPLOYER_SA  --repo $REPO_SLUG --body '$DEPLOYER_EMAIL'"
echo
echo "  Then: Actions -> deploy-cloudrun -> Run workflow, or merge to main."
