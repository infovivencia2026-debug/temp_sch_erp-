#!/usr/bin/env bash
# Unit tests for seller-console provisioning (src/services/provision.ts) with
# fakes: no Cloudflare account, no network. Needs Node 22+ (node:sqlite).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
npx esbuild test/provision.test.ts --bundle --platform=node --format=esm \
  --loader:.sql=text --outfile="$out/provision.test.mjs" --log-level=warning
node --no-warnings --test "$out/provision.test.mjs"
