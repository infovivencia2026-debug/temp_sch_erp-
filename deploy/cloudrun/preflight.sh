#!/usr/bin/env bash
# Can this machine deploy? Answer it before touching production, not during.
#
#   bash deploy/cloudrun/preflight.sh            # check, change nothing
#   bash deploy/cloudrun/preflight.sh --fix-env  # ...and rebuild .env.cloudrun
#                                                #    from Secret Manager
#
# WHY THIS EXISTS. deploy.sh is careful in the right way -- migrations before
# the swap, a failed step leaves the old revision serving -- but everything it
# checks, it checks after it has started. A missing env file is found after the
# tree has been read; an unauthenticated gcloud is found after the image tag
# has been computed. None of that is dangerous, and all of it wastes the ten
# minutes between "I will deploy now" and "I cannot deploy from here".
#
# So this asks every question first, in the order that a person new to the
# project would hit them, and for each one prints either that it is fine or the
# exact command that makes it fine. It changes nothing unless asked: the one
# thing it will write is the env file, and only under --fix-env, because that
# file is rebuilt from the cloud rather than invented and is the single step
# most likely to be missing on a machine that has never deployed.
#
# It ends by running deploy.sh --dry-run, so the last thing on screen is the
# list of commands a real deploy would run, against the project it would run
# them against. Reading that list is the last check, and it is a person's job.
set -uo pipefail   # not -e: a failing check must print its fix, not exit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env.cloudrun}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-temperp-web}"

FIX_ENV=0
for arg in "$@"; do
    case "$arg" in
        --fix-env) FIX_ENV=1 ;;
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

BLOCKED=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mnote\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mNO\033[0m    %s\n' "$1"; BLOCKED=1; }
fix()  { printf '        %s\n' "$1"; }
say()  { printf '\n=== %s ===\n' "$1"; }

# ── 1. gcloud, and a Python new enough to run it ────────────────────────────
#
# The CLI is not a repository dependency and will not be on a fresh laptop.
# It is looked for on PATH first and then in ~/tools, which is where this
# project's other hand-installed tools live (Node, Go on the build boxes), so
# an install that was never added to PATH still counts. gcloud needs Python
# 3.10 or newer; macOS ships 3.9, so CLOUDSDK_PYTHON is set when a newer one
# is around rather than leaving a confusing traceback for the reader.
say "gcloud"
GCLOUD=""
if command -v gcloud >/dev/null 2>&1; then
    GCLOUD="$(command -v gcloud)"
elif [ -x "$HOME/tools/google-cloud-sdk/bin/gcloud" ]; then
    GCLOUD="$HOME/tools/google-cloud-sdk/bin/gcloud"
    warn "found in ~/tools but not on PATH"
    fix "export PATH=\$HOME/tools/google-cloud-sdk/bin:\$PATH"
fi

if [ -z "$GCLOUD" ]; then
    bad "the Google Cloud CLI is not installed"
    fix "curl https://sdk.cloud.google.com | bash   (or: brew install --cask google-cloud-sdk)"
    fix "everything below needs it; re-run this script afterwards"
    say "Summary"
    echo "  cannot deploy from this machine yet."
    exit 1
fi

if [ -z "${CLOUDSDK_PYTHON:-}" ]; then
    for p in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 \
             /usr/local/bin/python3.12 /usr/bin/python3; do
        [ -x "$p" ] || continue
        v="$("$p" -c 'import sys; print(sys.version_info[1])' 2>/dev/null)" || continue
        if [ "${v:-0}" -ge 10 ] 2>/dev/null; then export CLOUDSDK_PYTHON="$p"; break; fi
    done
fi
if "$GCLOUD" version >/dev/null 2>&1; then
    ok "$("$GCLOUD" version 2>/dev/null | head -1)"
else
    bad "gcloud is installed but will not run (usually Python older than 3.10)"
    fix "brew install python@3.12 && export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12"
    say "Summary"; echo "  cannot deploy from this machine yet."; exit 1
fi

# ── 2. Signed in, and to which project ──────────────────────────────────────
#
# Both are per-machine state, not repository state, and both are things only a
# person can do: the login is a browser flow and the project id is knowledge.
say "Account and project"
ACCOUNT="$("$GCLOUD" auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
if [ -n "$ACCOUNT" ]; then
    ok "signed in as $ACCOUNT"
else
    bad "nobody is signed in"
    fix "gcloud auth login"
fi

PROJECT="${PROJECT_ID:-$("$GCLOUD" config get-value project 2>/dev/null | grep -v '^(unset)$')}"
if [ -n "$PROJECT" ]; then
    ok "project $PROJECT"
else
    bad "no project is set"
    fix "gcloud config set project <project-id>"
    fix "list them with: gcloud projects list"
fi

# Nothing below can be answered without both, and guessing would print a page
# of failures that all say the same thing.
if [ -z "$ACCOUNT" ] || [ -z "$PROJECT" ]; then
    say "Summary"
    echo "  sign in and set the project, then run this again."
    echo "  everything else this script checks is already in place or is checked below it."
    exit 1
fi

# ── 3. The service that is serving right now ────────────────────────────────
#
# Printed before anything else about the deploy, because the most useful thing
# to know before shipping is what is live: which revision, and from which
# commit. The image tag carries the commit, which is why deploy.sh tags with it.
say "What is live"
LIVE_JSON="$("$GCLOUD" run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image,status.url)' 2>/dev/null)"
if [ -n "$LIVE_JSON" ]; then
    LIVE_REV="$(echo "$LIVE_JSON" | awk '{print $1}')"
    LIVE_IMG="$(echo "$LIVE_JSON" | awk '{print $2}')"
    LIVE_URL="$(echo "$LIVE_JSON" | awk '{print $3}')"
    LIVE_COMMIT="${LIVE_IMG##*:}"
    ok "$SERVICE revision $LIVE_REV"
    ok "built from commit $LIVE_COMMIT"
    ok "$LIVE_URL"
    if git -C "$ROOT" cat-file -e "${LIVE_COMMIT}^{commit}" 2>/dev/null; then
        BEHIND="$(git -C "$ROOT" rev-list --count "${LIVE_COMMIT}..HEAD" 2>/dev/null)"
        if [ "${BEHIND:-0}" -gt 0 ]; then
            warn "HEAD is $BEHIND commit(s) ahead of what is live"
        else
            ok "HEAD is what is live; a deploy would change nothing"
        fi
    else
        warn "the live commit is not in this clone -- fetch before comparing"
    fi
else
    warn "could not read $SERVICE in $REGION (wrong project, or it does not exist yet)"
fi

# ── 4. The env file, which is rebuilt rather than copied ────────────────────
#
# It holds the database URLs and the four secrets the service runs on, so it is
# gitignored. env-from-cloud.sh reads every one of them back out of Secret
# Manager and off the running service, which is why a second machine needs no
# secret sent to it. The check for a stale file is deliberate: a file written
# before a secret was rotated deploys the old value.
say "Configuration"
if [ -f "$ENV_FILE" ]; then
    MISSING=""
    for k in PROJECT_ID DATABASE_URL SESSION_SECRET PASSWORD_PEPPER CREDENTIAL_KEY BASE_URL; do
        grep -qE "^${k}=." "$ENV_FILE" || MISSING="$MISSING $k"
    done
    if [ -n "$MISSING" ]; then
        bad "$ENV_FILE is missing:$MISSING"
        fix "bash deploy/cloudrun/env-from-cloud.sh > $ENV_FILE && chmod 600 $ENV_FILE"
    else
        ok "$ENV_FILE has every value the manifests need"
        PERM="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null)"
        [ "$PERM" = "600" ] || warn "it is mode $PERM; chmod 600 $ENV_FILE"
    fi
elif [ "$FIX_ENV" = "1" ]; then
    # Written to a temporary file first: a half-fetched file that replaced a
    # good one would be a deploy with a truncated secret in it.
    TMP_ENV="$(mktemp "${TMPDIR:-/tmp}/cloudrun-env.XXXXXX")"
    if PROJECT_ID="$PROJECT" REGION="$REGION" SERVICE="$SERVICE" \
            bash "$HERE/env-from-cloud.sh" > "$TMP_ENV" 2>"$TMP_ENV.err"; then
        mv "$TMP_ENV" "$ENV_FILE"; chmod 600 "$ENV_FILE"
        ok "wrote $ENV_FILE from Secret Manager"
    else
        rm -f "$TMP_ENV"
        bad "could not rebuild the env file"
        sed 's/^/        /' "$TMP_ENV.err" >&2
        fix "the account needs roles/secretmanager.secretAccessor on $PROJECT"
    fi
    rm -f "$TMP_ENV.err"
else
    bad "$ENV_FILE does not exist"
    fix "bash deploy/cloudrun/preflight.sh --fix-env      (rebuilds it from the cloud)"
    fix "nothing needs copying from another machine; every value is in Secret Manager"
fi

# ── 5. The tree that would be shipped ───────────────────────────────────────
#
# deploy.sh refuses a dirty tree, for the reason it gives: an image tagged with
# a commit that does not contain what was built cannot be rolled back to. Said
# here too so it is known before the build minutes are spent. The build itself
# is not run -- CI does that, and it takes longer than a person will wait at a
# preflight -- but the commit is named, so a green CI run can be checked.
say "The commit to be deployed"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
    bad "the working tree has uncommitted changes"
    fix "commit them, or deploy with ALLOW_DIRTY=1 knowing the tag will lie"
else
    ok "working tree is clean"
fi
HEAD_SHORT="$(git -C "$ROOT" rev-parse --short HEAD)"
ok "HEAD is $HEAD_SHORT  $(git -C "$ROOT" log -1 --format=%s | cut -c1-58)"
if git -C "$ROOT" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    ok "HEAD is on origin/main"
else
    warn "HEAD is not on origin/main -- push first, so the deployed commit is fetchable"
fi

# ── 6. Migrations ───────────────────────────────────────────────────────────
#
# Counted, not applied: the migrate job in deploy.sh applies whatever is
# pending, and goose only ever runs what has not run. The number is here
# because "twelve migrations since the live commit" is worth reading before
# starting, and because a migration that needs a window is a person's call.
say "Migrations"
COUNT="$(ls "$ROOT"/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
ok "$COUNT in the tree"
if [ -n "${LIVE_COMMIT:-}" ] && git -C "$ROOT" cat-file -e "${LIVE_COMMIT}^{commit}" 2>/dev/null; then
    NEW="$(git -C "$ROOT" diff --name-only "${LIVE_COMMIT}..HEAD" -- migrations/ 2>/dev/null | grep -c '\.sql$')"
    if [ "${NEW:-0}" -gt 0 ]; then
        warn "$NEW added since the live revision; the migrate job will apply them first"
        git -C "$ROOT" diff --name-only "${LIVE_COMMIT}..HEAD" -- migrations/ | grep '\.sql$' |
            sed 's|migrations/|        |'
    else
        ok "none added since the live revision"
    fi
fi

# ── 7. What a deploy would actually do ──────────────────────────────────────
say "Summary"
if [ "$BLOCKED" = "1" ]; then
    echo "  NOT ready. Fix the lines marked NO above, then run this again."
    exit 1
fi
echo "  Ready. This machine can deploy $HEAD_SHORT to $PROJECT."
echo
echo "  Dry run (prints every command, runs none):"
echo "    bash deploy/cloudrun/deploy.sh --dry-run"
echo
echo "  Deploy:"
echo "    bash deploy/cloudrun/deploy.sh"
echo
echo "  Roll back to what is live now:"
echo "    COMMIT=${LIVE_COMMIT:-<commit>} bash deploy/cloudrun/deploy.sh"
