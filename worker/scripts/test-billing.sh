#!/usr/bin/env bash
# Unit tests for seller billing and onboarding (src/routes/seller/billing.ts,
# onboarding.ts) with fakes: no Cloudflare account, no network, no payment
# gateway, nothing sent. Needs Node 22+ (node:sqlite).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
npx esbuild test/billing.test.ts --bundle --platform=node --format=esm \
  --alias:cloudflare:sockets=./test/cf-stubs.ts --alias:cloudflare:workers=./test/cf-stubs.ts \
  --alias:cloudflare:sockets=./test/cf-stubs.ts --alias:cloudflare:workers=./test/cf-stubs.ts \
  --loader:.sql=text --outfile="$out/billing.test.mjs" --log-level=warning
node --no-warnings --test "$out/billing.test.mjs"
