#!/usr/bin/env bash
# Rebuilds the Material Symbols Rounded subset the feature plates use.
#
# The full Rounded face is ~3.5MB; the names in feature-icons.tsx come to
# ~100KB when Google Fonts cuts the font down to them (FILL 1, weight 500,
# optical size kept as an axis). Run this after adding a name to the table,
# then commit the woff2 and the manifest beside it. The test in
# feature-icons.test.ts fails while the manifest is behind the table.
set -euo pipefail
cd "$(dirname "$0")/.."
FONTS=src/assets/fonts
NAMES=$(node -e '
  const s = require("fs").readFileSync("src/features/bento/feature-icons.tsx","utf8");
  const n = new Set(["apps"]);
  for (const m of s.matchAll(/: \x27([a-z0-9_]+)\x27/g)) n.add(m[1]);
  console.log([...n].sort().join(","));
')
URL="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,500,1,0&icon_names=${NAMES}&display=swap"
CSS=$(curl -fsS -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36" "$URL")
SRC=$(printf '%s' "$CSS" | grep -o 'url([^)]*)' | head -1 | sed 's/^url(//;s/)$//')
[ -n "$SRC" ] || { echo "no woff2 in the Google Fonts response" >&2; exit 1; }
curl -fsS "$SRC" -o "$FONTS/material-symbols-rounded-subset.woff2"
node -e '
  const names = process.argv[1].split(",");
  require("fs").writeFileSync(process.argv[2], JSON.stringify(names, null, 2) + "\n");
' "$NAMES" "$FONTS/material-symbols-rounded-subset.json"
ls -la "$FONTS/material-symbols-rounded-subset.woff2"
