#!/usr/bin/env bash
# Is the site up? Asked from outside the box, because on the evening of
# 2026-09-07 the VPS went offline and nobody was told: there was no uptime
# monitor, no alert, and the operator found out by asking. This is the probe
# that .github/workflows/uptime.yml runs every ten minutes; it is also a plain
# script so anyone can run it by hand from a laptop when the site feels slow.
#
#   bash scripts/uptime-check.sh https://temperp.187-127-178-100.sslip.io
#       GET <url>/healthz. Exit 0 when it answers 200, exit 1 otherwise.
#
#   bash scripts/uptime-check.sh <url> --apk
#       also HEAD <url>/apps/parent.apk and warn (on stdout, never in the exit
#       code) unless it is a 200 with Content-Type
#       application/vnd.android.package-archive. That link once served the
#       SPA's HTML for days -- a phone saved 3 KB of index.html as the app --
#       because nginx had no rule for /apps (see the Apps route block in
#       scripts/build-on-server.sh). A wrong download is not an outage, so it
#       is reported separately and does not fail the script.
#
#   HEALTH_PATH=/ bash scripts/uptime-check.sh https://github.com
#       probe a different path; handy for trying the UP branch against a
#       site that is known to be up while ours is not.
#
# One probe is not a verdict. A single lost packet between a GitHub runner and
# the box must not open an outage issue, so the check is tried up to three
# times (ATTEMPTS), RETRY_WAIT seconds apart, and only the last answer counts.
# Anything that is not a 200 -- a 5xx from nginx, a 000 from curl for a refused
# connection or a timeout -- is DOWN; the difference is in the report, not the
# decision, because every one of them is a site a parent cannot open.
#
# When GITHUB_OUTPUT is set (inside Actions) the result is also written there
# as step outputs: status=up|down, http=<code>, detail, apk=ok|bad|skipped,
# apk_detail.
set -uo pipefail

usage() { echo "usage: $0 <base-url> [--apk]" >&2; exit 2; }
BASE=${1:-}; [ -n "$BASE" ] || usage
BASE=${BASE%/}
CHECK_APK=0
case "${2:-}" in
    "") ;;
    --apk) CHECK_APK=1 ;;
    *) usage ;;
esac
command -v curl >/dev/null || { echo "uptime-check: curl not installed" >&2; exit 2; }

ATTEMPTS=${ATTEMPTS:-3}          # 1 try + 2 retries
RETRY_WAIT=${RETRY_WAIT:-20}     # seconds between them; about a minute in all
CONNECT_TIMEOUT=${CONNECT_TIMEOUT:-10}
MAX_TIME=${MAX_TIME:-20}         # /healthz answers in milliseconds when it answers at all
TZ_SHOW=${TZ_SHOW:-Asia/Kolkata}

now() { TZ=$TZ_SHOW date '+%Y-%m-%d %H:%M %Z'; }

out() {   # out key value -> a step output inside Actions, always on stdout
    echo "$1=$2"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"
    return 0
}

# --- /healthz -----------------------------------------------------------------
HEALTH="$BASE${HEALTH_PATH:-/healthz}"
code=000; detail=""
for (( i=1; i<=ATTEMPTS; i++ )); do
    # -w prints the code even on failure; curl's own exit code tells a timeout
    # (28) from a refused connection (7) and from DNS (6), which is worth a
    # word in the issue because they point at different things to check.
    code=$(curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
        -A "temperp-uptime-check" "$HEALTH" 2>/dev/null)
    rc=$?
    case "$rc" in
        0)  detail="HTTP $code" ;;
        6)  detail="DNS lookup failed" ;;
        7)  detail="connection refused (nothing listening, or the box is off)" ;;
        28) detail="timed out (connect ${CONNECT_TIMEOUT}s, total ${MAX_TIME}s; box or network unreachable)" ;;
        35|60) detail="TLS failed (curl exit $rc)" ;;
        *)  detail="curl exit $rc" ;;
    esac
    if [ "$code" = 200 ]; then break; fi
    echo "$(now)  attempt $i/$ATTEMPTS: $HEALTH -> $detail"
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$RETRY_WAIT"
done

if [ "$code" = 200 ]; then
    echo "$(now)  UP    $HEALTH -> $detail"
    out status up
else
    echo "$(now)  DOWN  $HEALTH -> $detail (after $ATTEMPTS attempts)"
    out status down
fi
out http "$code"
out detail "$detail"

# --- /apps/parent.apk ---------------------------------------------------------
# Only asked when the site is up: a dead box serves no APK either, and one
# outage should not read as two.
if [ "$CHECK_APK" = 1 ] && [ "$code" = 200 ]; then
    APK="$BASE/apps/parent.apk"
    hdrs=$(curl -sS -I --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
        -A "temperp-uptime-check" "$APK" 2>/dev/null)
    acode=$(printf '%s\n' "$hdrs" | awk 'toupper($1) ~ /^HTTP\// {c=$2} END {print c+0}')
    ctype=$(printf '%s\n' "$hdrs" | awk -F': *' 'tolower($1)=="content-type" {print $2}' | tr -d '\r' | tail -1)
    if [ "$acode" = 200 ] && [[ "$ctype" == application/vnd.android.package-archive* ]]; then
        echo "$(now)  APK   $APK -> HTTP 200 $ctype"
        out apk ok
        out apk_detail "HTTP 200 $ctype"
    else
        echo "$(now)  WARN  $APK -> HTTP $acode Content-Type '${ctype:-none}' (want application/vnd.android.package-archive)"
        out apk bad
        out apk_detail "HTTP $acode, Content-Type '${ctype:-none}'"
    fi
else
    out apk skipped
    out apk_detail ""
fi

[ "$code" = 200 ]
