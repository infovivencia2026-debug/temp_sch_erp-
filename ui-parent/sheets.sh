#!/bin/bash
# Contact sheets for a phase: ui-parent/sheets/<phase>-<device>-<theme>-N.png
set -e
cd "$(dirname "$0")"
PHASE=${1:-before}
ONLY=${2:-}
mkdir -p sheets
TMP=$(mktemp -d /tmp/claude-1000/-home-qb-temp-sch-erp-/beaf6ca8-5684-4269-b99d-ba4dbf32f1b1/scratchpad/sheet.XXXX)
for combo in phone-light desktop-light phone-dark desktop-dark; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$combo" ] && continue
  files=()
  for f in "$PHASE"/*--"$combo".png; do
    b=$(basename "$f" .png)
    if [[ $combo == phone* ]]; then magick "$f" -resize 300x -gravity North -crop 300x650+0+0 +repage "$TMP/$b.png"; else magick "$f" -resize 480x -gravity North -crop 480x300+0+0 +repage "$TMP/$b.png"; fi
    files+=("$TMP/$b.png")
  done
  n=${#files[@]}
  [ "$n" -eq 0 ] && continue
  if [[ $combo == phone* ]]; then tile="6x3"; per=18; else tile="3x4"; per=12; fi
  i=0; k=1
  while [ $i -lt $n ]; do
    chunk=("${files[@]:$i:$per}")
    montage "${chunk[@]}" -tile "$tile" -geometry +6+6 -label '%t' -pointsize 11 "sheets/$PHASE-$combo-$k.png"
    i=$((i+per)); k=$((k+1))
  done
done
rm -rf "$TMP"
ls sheets
