#!/usr/bin/env bash
# Unit tests for early warnings and smart import (src/services/ai) with a fake
# Gemini and node:sqlite: no key, no network. Needs Node 22+ (node:sqlite).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
npx esbuild test/ai.test.ts --bundle --platform=node --format=esm \
  --alias:cloudflare:sockets=./test/cf-stubs.ts --alias:cloudflare:workers=./test/cf-stubs.ts \
  --loader:.sql=text --outfile="$out/ai.test.mjs" --log-level=warning
node --no-warnings --test "$out/ai.test.mjs"
