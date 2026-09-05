#!/usr/bin/env bash
# Keep the old sslip.io hostname answering after cut-over by proxying it to
# the new origin. Run on the VPS as root, once, at Stage 5 of
# docs/arch_lowcost.txt. Idempotent: run it again with the same arguments and
# it rewrites the same file and changes nothing else.
#
#   scripts/proxy-old-host.sh https://erp.example.com
#   scripts/proxy-old-host.sh https://erp.example.com temperp.187-127-178-100.sslip.io
#   scripts/proxy-old-host.sh --dry-run https://erp.example.com     # print, install nothing
#
# WHY THIS EXISTS. temperp.187-127-178-100.sslip.io is wildcard DNS: the name
# encodes the VPS address and sslip.io will resolve it there forever. We
# cannot repoint it. Paired devices keep calling it for months -- the release
# bus-tracker APK hard-codes the host, SMS-gateway handsets stored it when
# they paired, biometric readers post to /iclock on it -- so the VPS must keep
# answering that name and hand every request to the new home.
#
# WHAT IT CHANGES. Exactly one file, /etc/nginx/sites-available/${SERVICE},
# which scripts/deploy.sh wrote. The local-upstream version is kept beside it
# as ${SERVICE}.local-upstream; rolling back is one command, printed at the end.
# The TLS certificate, its renewal config and the webroot challenge path are
# untouched, so certbot keeps renewing the old name. The Go service, Postgres
# and everything else on the box are left running so the rollback is real.
#
# WHAT THE NEW ORIGIN SEES. The new origin is Cloudflare Pages (a Function
# proxying to Cloud Run). Cloudflare sets CF-Connecting-IP to whoever connected
# to IT -- which, for this traffic, is the VPS. So for every request that
# arrives via the old name the Go side sees 187.127.178.100 as the client:
# rate limiters keyed on IP share one bucket across all old-host devices, and
# sessions.ip records the VPS. The true device address travels as the FIRST
# X-Forwarded-For hop, which RealIP deliberately does not trust. Accepted for
# the overlap: the population is a few dozen devices, and it shrinks as they
# are rebuilt (Stage 6). If the pair-code limiter trips because of it, raise
# it or exempt the VPS address in Go; do not weaken RealIP.
#
# COOKIES. The app sets erp_session and erp_csrf with Path=/ and NO Domain
# attribute (internal/auth/session.go, internal/auth/handler.go), so browsers
# scope them to whichever host answered. A sign-in on the old name lives on the
# old name only; the new name gets its own. Sessions therefore do NOT carry
# across the two hostnames -- a user who moves to the new address signs in
# again. Nothing to rewrite today; proxy_cookie_domain below is a guard in
# case a Domain attribute is ever added.
#
# NOT A REDIRECT. Devices cannot follow a 301 to a host they were not built
# for (the bus-tracker pins its host; ADMS readers ignore Location), so every
# path is proxied. Browsers do follow absolute Location headers the Go side
# builds from BASE_URL, and those name the new host, so people drift to the
# new address on their own as they sign in and out.

set -euo pipefail

SERVICE="${SERVICE:-temperp}"
OLD_HOST_DEFAULT="temperp.187-127-178-100.sslip.io"
# Resolvers for re-resolving the new origin. Cloudflare rotates edge
# addresses; a static proxy_pass would pin the one nginx saw at reload.
RESOLVER="${RESOLVER:-1.1.1.1 8.8.8.8}"
# 64m matches maxLocalUploadBytes in internal/api/files_local.go and the
# block deploy.sh wrote; uploads still cross this box on the way to R2.
MAX_BODY="${MAX_BODY:-64m}"
CA_BUNDLE="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"

DRY_RUN=0
KEEP_TILES=0
POSITIONAL=()
for arg in "$@"; do
    case "$arg" in
        --dry-run)    DRY_RUN=1 ;;
        --keep-tiles) KEEP_TILES=1 ;;
        -h|--help)
            sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        --*) echo "unknown option: $arg" >&2; exit 2 ;;
        *)  POSITIONAL+=("$arg") ;;
    esac
done

NEW_ORIGIN="${POSITIONAL[0]:-${NEW_ORIGIN:-}}"
OLD_HOST="${POSITIONAL[1]:-${OLD_HOST:-$OLD_HOST_DEFAULT}}"

if [ -z "$NEW_ORIGIN" ]; then
    echo "usage: $0 [--dry-run] [--keep-tiles] NEW_ORIGIN [OLD_HOST]" >&2
    echo "   eg: $0 https://erp.example.com" >&2
    exit 2
fi
# NEW_ORIGIN is a scheme and a host, nothing else: proxy_pass with a variable
# forwards the request URI unchanged, so a path here would be silently lost.
NEW_ORIGIN="${NEW_ORIGIN%/}"
case "$NEW_ORIGIN" in
    https://*) NEW_SCHEME=https ;;
    http://*)  NEW_SCHEME=http ;;
    *) echo "NEW_ORIGIN must start with https:// (got: $NEW_ORIGIN)" >&2; exit 2 ;;
esac
NEW_HOST="${NEW_ORIGIN#*://}"
if [[ "$NEW_HOST" == */* || -z "$NEW_HOST" ]]; then
    echo "NEW_ORIGIN must be scheme://host[:port] with no path (got: $NEW_ORIGIN)" >&2
    exit 2
fi
if [ "$NEW_HOST" = "$OLD_HOST" ]; then
    echo "NEW_ORIGIN names the old host itself; that would loop" >&2
    exit 2
fi

SITE="/etc/nginx/sites-available/${SERVICE}"
BACKUP="${SITE}.local-upstream"
MARKER="# managed by scripts/proxy-old-host.sh"
WEBROOT="${WEBROOT:-/var/www/${SERVICE}}"
TILES_DIR="/var/www/${SERVICE}-tiles"
LE_DIR="/etc/letsencrypt/live/${OLD_HOST}"

# ---- the TLS block: the same shape deploy.sh emits, same certificate --------
SSL_BLOCK=""
REDIRECT_BLOCK=""
if [ -d "$LE_DIR" ]; then
    SSL_BLOCK="listen 443 ssl http2;
    ssl_certificate     ${LE_DIR}/fullchain.pem;
    ssl_certificate_key ${LE_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    REDIRECT_BLOCK="if (\$scheme = http) { return 301 https://\$host\$request_uri; }"
elif [ "$DRY_RUN" = 0 ]; then
    echo "!! no certificate at ${LE_DIR}; the old name will answer on port 80 only" >&2
fi

# Cloudflare's certificate chains to a public CA; verify it, because session
# cookies and pair codes cross the public internet on this hop. If the bundle
# is missing (unusual on Debian/Ubuntu) verification is skipped with a warning.
SSL_VERIFY="proxy_ssl_verify              on;
proxy_ssl_trusted_certificate ${CA_BUNDLE};
proxy_ssl_verify_depth        3;"
# The bundle check is about the VPS, so a dry run elsewhere does not do it.
if [ "$DRY_RUN" = 0 ] && [ "$NEW_SCHEME" = https ] && [ ! -f "$CA_BUNDLE" ]; then
    echo "!! ${CA_BUNDLE} not found; upstream certificate will NOT be verified" >&2
    SSL_VERIFY="proxy_ssl_verify off;"
fi
UPSTREAM_TLS=""
if [ "$NEW_SCHEME" = https ]; then
    UPSTREAM_TLS="proxy_ssl_server_name on;
proxy_ssl_name        \$new_host;
proxy_ssl_protocols   TLSv1.2 TLSv1.3;
${SSL_VERIFY}"
fi

TILES_BLOCK=""
if [ "$KEEP_TILES" = 1 ]; then
    if [ -d "$TILES_DIR" ]; then
        TILES_BLOCK="# --keep-tiles: the iPhone shell still reads PMTiles from this box until
    # TILES_BASE points at R2 (docs/self-hosted tiles). Served locally as before.
    location /tiles/ {
        alias ${TILES_DIR}/;
        add_header Cache-Control \"public, max-age=86400\";
        add_header Access-Control-Allow-Origin \"*\";
        access_log off;
    }"
    else
        echo "!! --keep-tiles given but ${TILES_DIR} does not exist; proxying /tiles/ too" >&2
    fi
fi

CONFIG="$(cat <<NGINX
${MARKER}
# old host  : ${OLD_HOST}
# new origin: ${NEW_ORIGIN}
# rollback  : cp ${BACKUP} ${SITE} && nginx -t && systemctl reload nginx
#
# Every path on the old name is forwarded to the new origin with the Host
# rewritten. Nothing here is served by the Go service on this box any more;
# it is still running only so the rollback above is instant.

server {
    listen 80;
    server_name ${OLD_HOST};

    ${SSL_BLOCK}
    ${REDIRECT_BLOCK}

    access_log /var/log/nginx/${SERVICE}.access.log;
    error_log  /var/log/nginx/${SERVICE}.error.log;

    client_max_body_size ${MAX_BODY};

    # Re-resolve the new origin: Cloudflare rotates edge addresses, and a
    # literal proxy_pass would pin whatever nginx saw at reload. Using a
    # variable makes nginx honour the DNS TTL through this resolver.
    resolver ${RESOLVER} valid=300s ipv6=off;
    set \$new_host   ${NEW_HOST};
    set \$new_origin ${NEW_ORIGIN};

    # Certbot renews the old name through the webroot; this must stay local.
    location /.well-known/acme-challenge/ { root /var/www/html; }

    ${TILES_BLOCK}

    # No caching anywhere the API or the readers speak. There is no
    # proxy_cache zone in this file, so nothing is cached in any case; these
    # make it explicit so a later edit cannot add one by accident.
    location /api/    { include /etc/nginx/snippets/${SERVICE}-oldhost.conf; proxy_cache off; expires off; }
    location /iclock/ { include /etc/nginx/snippets/${SERVICE}-oldhost.conf; proxy_cache off; expires off; }
    location /healthz { include /etc/nginx/snippets/${SERVICE}-oldhost.conf; access_log off; }

    location / { include /etc/nginx/snippets/${SERVICE}-oldhost.conf; }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX
)"

# The forwarding rules, in a snippet so the three locations above share one
# definition. Separate from ${SERVICE}-proxy.conf, which the rollback still
# needs intact.
SNIPPET_PATH="/etc/nginx/snippets/${SERVICE}-oldhost.conf"
SNIPPET="$(cat <<PROXY
${MARKER}
proxy_pass \$new_origin;
proxy_http_version 1.1;
${UPSTREAM_TLS}

# Host is the new origin's: Cloudflare routes on it and the Go side builds
# cookies and redirects for the host it is asked for. The old name travels in
# X-Forwarded-Host for the logs; the Pages Function overwrites it with the
# Pages host before Cloud Run sees it, and the Go side does not read it.
proxy_set_header Host              \$new_host;
proxy_set_header X-Forwarded-Host  \$host;
proxy_set_header X-Forwarded-Proto \$scheme;
# The device address is the first hop here. Cloudflare appends this box's
# address after it and sets CF-Connecting-IP to this box, which is what RealIP
# in internal/httpx/middleware.go takes. See the header comment in
# scripts/proxy-old-host.sh for what that means.
proxy_set_header X-Real-IP         \$remote_addr;
proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
proxy_set_header X-Request-Id      \$request_id;
proxy_set_header Connection        "";

# Stream both ways. Readers post attendance in one long body to /iclock and
# teachers upload recordings up to ${MAX_BODY}; buffering them to disk on a
# 1 vCPU box gains nothing. Responses stream too, so APK downloads and CSV
# exports do not wait for the whole body.
proxy_request_buffering off;
proxy_buffering         off;

# Cloud Run scales to zero: the first request after idle waits a few seconds
# for a cold start, and SMS handsets on 2G radios are slow senders. Generous
# timeouts cost nothing when unused.
proxy_connect_timeout 15s;
proxy_send_timeout    300s;
proxy_read_timeout    300s;

# Let absolute Location headers through untouched. The Go side builds them
# from BASE_URL, which is the new host, and a browser that follows one has
# migrated -- which is the point. Devices never follow redirects.
proxy_redirect off;

# The app sets no Domain on its cookies (host-only), so this never matches
# today; it is here so a Domain added later still lands on the old name.
proxy_cookie_domain ${NEW_HOST} ${OLD_HOST};
PROXY
)"

if [ "$DRY_RUN" = 1 ]; then
    echo "# ---- ${SITE} ----"
    echo "$CONFIG"
    echo
    echo "# ---- ${SNIPPET_PATH} ----"
    echo "$SNIPPET"
    echo
    echo "# dry run: nothing written. Rollback after a real run:"
    echo "#   cp ${BACKUP} ${SITE} && nginx -t && systemctl reload nginx"
    exit 0
fi

# ---- install ---------------------------------------------------------------
if [ "$(id -u)" != 0 ]; then echo "run as root" >&2; exit 1; fi
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }
if [ ! -f "$SITE" ]; then
    echo "!! ${SITE} does not exist; deploy.sh has not run here. Refusing." >&2
    exit 1
fi

# Keep the local-upstream config exactly once. A file that already carries
# our marker is ours and not worth keeping; a file without it is deploy.sh's,
# and if a backup already exists (deploy.sh re-ran after we did) a dated copy
# is kept so the original is never overwritten.
if ! grep -qF "$MARKER" "$SITE"; then
    if [ ! -f "$BACKUP" ]; then
        cp -p "$SITE" "$BACKUP"
        echo "kept local-upstream config: ${BACKUP}"
    else
        cp -p "$SITE" "${BACKUP}.$(date +%Y%m%d%H%M%S)"
        echo "kept a dated copy; ${BACKUP} left as the rollback target"
    fi
fi

# Write, test, and only then reload. A rejected config is put back before
# nginx is asked anything, so a running site never sees the bad file.
TMP_SITE="$(mktemp)"; TMP_SNIP="$(mktemp)"
trap 'rm -f "$TMP_SITE" "$TMP_SNIP"' EXIT
cp -p "$SITE" "$TMP_SITE"
[ -f "$SNIPPET_PATH" ] && cp -p "$SNIPPET_PATH" "$TMP_SNIP" || : > "$TMP_SNIP"

install -d /etc/nginx/snippets
printf '%s\n' "$SNIPPET" > "$SNIPPET_PATH"
printf '%s\n' "$CONFIG"  > "$SITE"
ln -sfn "$SITE" "/etc/nginx/sites-enabled/${SERVICE}"

if nginx -t; then
    systemctl reload nginx
    echo
    echo "${OLD_HOST} now proxies every path to ${NEW_ORIGIN}"
    echo "check : curl -sSI https://${OLD_HOST}/healthz"
    echo "        curl -sS  https://${OLD_HOST}/api/v1/ping   # or any known API path"
    echo "        tail -f /var/log/nginx/${SERVICE}.access.log | grep -v healthz"
    echo "renew : certbot renew --dry-run   # webroot path is still local"
    echo "rollback (one command):"
    echo "  cp ${BACKUP} ${SITE} && nginx -t && systemctl reload nginx"
    echo "note  : do not re-run scripts/deploy.sh on this box; it rewrites ${SITE}"
    echo "        with the local upstream. If it must run, run this script again after."
else
    echo "!! nginx rejected the config; restoring the previous files" >&2
    cp -p "$TMP_SITE" "$SITE"
    if [ -s "$TMP_SNIP" ]; then cp -p "$TMP_SNIP" "$SNIPPET_PATH"; else rm -f "$SNIPPET_PATH"; fi
    nginx -t || true
    exit 1
fi
