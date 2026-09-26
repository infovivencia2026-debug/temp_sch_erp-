#!/usr/bin/env bash
# Copy the Worker's secrets from Google Secret Manager to Cloudflare, without
# the values ever being printed, written to a file, or pasted into a chat.
#
#   gcloud auth login              # an account with access to the GCP project
#   gcloud config set project project-2a0e3e6a-308a-4484-9cb
#   cd worker && npx wrangler login   # the Cloudflare account
#   bash scripts/secrets-from-cloud.sh
#
# Each value goes straight from `gcloud secrets versions access` into
# `wrangler secret put` through a pipe. Re-running it is safe: it overwrites
# each secret with the same value.
#
# Not in Secret Manager, set by hand if you need them:
#   GOOGLE_API_KEY       a Gemini API key from https://aistudio.google.com/apikey
#                        (AI question generation). The one in Secret Manager
#                        (temperp-google-api-key) is refused by Google.
#   FCM_SERVICE_ACCOUNT  Firebase service-account JSON (push). Production has
#                        push switched off, so this is optional:
#                        npx wrangler secret put FCM_SERVICE_ACCOUNT < file.json
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/tools/node22/bin:$PATH"

# Worker secret name        Secret Manager id
PAIRS=(
  "PASSWORD_PEPPER          temperp-password-pepper"
  "CREDENTIAL_KEY           temperp-credential-key"
  "SESSION_SECRET           temperp-session-secret"
)

gcloud config get-value project >/dev/null 2>&1 || { echo "run: gcloud auth login" >&2; exit 1; }
npx wrangler whoami >/dev/null 2>&1 || { echo "run: npx wrangler login" >&2; exit 1; }

for row in "${PAIRS[@]}"; do
  read -r name id <<<"$row"
  if ! gcloud secrets versions access latest --secret="$id" >/dev/null 2>&1; then
    echo "skip $name: cannot read $id from Secret Manager" >&2
    continue
  fi
  gcloud secrets versions access latest --secret="$id" | npx wrangler secret put "$name" >/dev/null
  echo "set $name"
done
echo "done. Check with: npx wrangler secret list"
