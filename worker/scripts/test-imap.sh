#!/usr/bin/env bash
# Unit tests for the IMAP reader and parsers (src/services/imap.ts): bytes fed
# in chunks, no socket. Needs Node 22+.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
npx esbuild test/imap.test.ts --bundle --platform=node --format=esm \
  --alias:cloudflare:sockets=./test/cf-stubs.ts --alias:cloudflare:workers=./test/cf-stubs.ts \
  --outfile="$out/imap.test.mjs" --log-level=warning
node --no-warnings --test "$out/imap.test.mjs"
