#!/usr/bin/env bash
# Queue maintenance for the ${SERVICE} asynq queues. Runs ON the server.
#
# Deploys restart the worker; they do not repair the queue. When a bad build
# ships, the damage outlives it: tasks that panicked are sitting in `archived`,
# tasks the dead worker had leased are stuck in `active` where nothing will
# ever pick them up again, and `retry` is full of jobs backing off against an
# error that was fixed three commits ago. Restarting the worker fixes none of
# that, which is why "the deploy went green and the queue is still dead" is the
# normal way this goes wrong.
#
# This is the repair path. Everything reads first and mutates only when asked,
# and every mutation names the commit it was run against, so a queue that gets
# drained by hand leaves a trace in the journal.
#
#   bash queue-maint.sh status                  # depths per queue
#   bash queue-maint.sh doctor                  # read-only health verdict, exit 1 if unhealthy
#   bash queue-maint.sh failed [N]              # what is archived, and why
#   bash queue-maint.sh retry <queue> --yes     # archived+retry -> pending
#   bash queue-maint.sh unstick <queue> --yes   # orphaned active -> pending
#   bash queue-maint.sh purge <queue> --yes     # drop archived tasks for good
#   bash queue-maint.sh restart                 # restart the worker, then doctor
#
# Queue names: critical | default | bulk | low | all
set -euo pipefail

SERVICE="${SERVICE:-temperp}"
ENV_FILE="${ENV_FILE:-/etc/${SERVICE}.env}"
SRC="${SRC:-/opt/${SERVICE}-src}"
QUEUES=(critical default bulk low)

# Depth at which a queue is called unhealthy rather than busy. Bulk is allowed
# a real backlog -- a 5,000-row import is one enqueue and a long tail -- while
# anything sitting in critical is a password reset nobody received.
declare -A MAX_PENDING=([critical]=50 [default]=500 [bulk]=5000 [low]=2000)
# An active task older than this has no live worker behind it. asynq's own
# recoverer uses the lease (30s, renewed while running); this is deliberately
# far beyond it so a genuinely long job is never mistaken for a corpse.
STALE_ACTIVE_SECS="${STALE_ACTIVE_SECS:-900}"

say()  { printf '\n=== %s ===\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

# --- redis ------------------------------------------------------------------
# The logical DB is not 0. Sessions and the queue share the Redis instance with
# whatever else is on the box, and REDIS_URL in the env file is the only place
# that says which database this deployment owns -- so read it rather than
# assume. Running these commands against DB 0 would report an empty, healthy
# queue while the real one is on fire.
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (run as root on the server)"
REDIS_URL="$(sed -n 's/^REDIS_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$REDIS_URL" ] || die "no REDIS_URL in $ENV_FILE"
REDIS_DB="$(printf '%s' "$REDIS_URL" | sed -n 's#.*/\([0-9]\+\)$#\1#p')"
REDIS_DB="${REDIS_DB:-0}"
r() { redis-cli -n "$REDIS_DB" "$@"; }

redis-cli ping >/dev/null 2>&1 || die "redis is not responding"

# asynq key layout (v0.25): asynq:{<queue>}:<set>. The braces are a Redis
# Cluster hash tag and are part of the literal key name -- quote them or the
# shell will not, and you will silently operate on a key that does not exist.
k() { printf 'asynq:{%s}:%s' "$1" "$2"; }

# The commit currently installed, so a manual drain is attributable. Reported,
# never enforced: the queue must be repairable even when the checkout is gone.
commit() { git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown; }

expand_queues() {
    case "${1:-all}" in
        all) printf '%s\n' "${QUEUES[@]}" ;;
        critical|default|bulk|low) printf '%s\n' "$1" ;;
        *) die "unknown queue '$1' (critical|default|bulk|low|all)" ;;
    esac
}

confirm() {
    # Destructive by default is how a status check turns into an incident.
    [ "${YES:-0}" = "1" ] || die "$1 — re-run with --yes"
}

# --- commands ---------------------------------------------------------------

cmd_status() {
    say "Queues (redis db ${REDIS_DB}, installed ${commit()})"
    printf '  %-10s %8s %8s %10s %8s %9s %8s\n' \
        queue pending active scheduled retry archived paused
    for q in "${QUEUES[@]}"; do
        local paused=no
        [ "$(r exists "$(k "$q" paused)")" = "1" ] && paused=YES
        printf '  %-10s %8s %8s %10s %8s %9s %8s\n' "$q" \
            "$(r llen  "$(k "$q" pending)")" \
            "$(r llen  "$(k "$q" active)")" \
            "$(r zcard "$(k "$q" scheduled)")" \
            "$(r zcard "$(k "$q" retry)")" \
            "$(r zcard "$(k "$q" archived)")" \
            "$paused"
    done
    echo
    printf '  worker: %s   web: %s\n' \
        "$(systemctl is-active "${SERVICE}-worker" 2>/dev/null || echo unknown)" \
        "$(systemctl is-active "${SERVICE}-web" 2>/dev/null || echo unknown)"
}

# stale_active <queue> -- ids in `active` whose lease has expired by more than
# STALE_ACTIVE_SECS. These are the jobs a killed worker was holding: asynq
# leaves them in the active list, and nothing outside the recoverer that died
# with them will ever move them back.
stale_active() {
    local q="$1" now; now="$(date +%s)"
    r --no-raw eval "
        local ids = redis.call('LRANGE', KEYS[1], 0, -1)
        local out = {}
        for _, id in ipairs(ids) do
            local lease = redis.call('ZSCORE', KEYS[2], id)
            if not lease or (tonumber(ARGV[1]) - tonumber(lease)) > tonumber(ARGV[2]) then
                table.insert(out, id)
            end
        end
        return out
    " 2 "$(k "$q" active)" "$(k "$q" lease)" "$now" "$STALE_ACTIVE_SECS" \
    | sed 's/^[0-9]*) *//; s/^"//; s/"$//' | grep -v '^(empty' || true
}

cmd_failed() {
    local limit="${1:-20}"
    for q in "${QUEUES[@]}"; do
        local n; n="$(r zcard "$(k "$q" archived)")"
        [ "$n" = "0" ] && continue
        say "archived in ${q} (${n} total, showing ${limit})"
        # The task payload is protobuf, so the error string is extracted rather
        # than parsed: it is the one field worth reading at 3am, and pulling in
        # a decoder would mean shipping a Go binary to read a queue.
        while read -r id; do
            [ -n "$id" ] || continue
            local msg; msg="$(r --no-raw hget "$(k "$q" t:"$id")" msg 2>/dev/null || true)"
            printf '  %s\n' "$id"
            # Matched against the known type names rather than a shape like
            # "word:word": the field is length-prefixed protobuf, so a loose
            # pattern picks the length byte up with it and prints "cmessage:send".
            printf '%s' "$msg" \
                | grep -oE 'reportcard:generate|invoice:generate|fee:reminder_fanout|message:send|message:dispatch|message:plans|bulk:import|export:build|attendance:rollup|session:prune' \
                | head -1 | sed 's/^/      type: /'
            printf '%s' "$msg" | grep -oE '[A-Za-z ][A-Za-z0-9 :._/-]{15,120}' | tail -1 | sed 's/^/      err:  /'
        done < <(r zrange "$(k "$q" archived)" 0 "$((limit - 1))")
    done
}

# move_set <queue> <set> -- archived|retry -> pending, mirroring what asynq's
# own RunTask does: drop from the zset, push onto pending, and rewrite the task
# state. Doing it in one EVAL matters -- a task that is in neither the zset nor
# the pending list because the shell died in between is lost, and the payload
# is the only copy of it.
move_set() {
    local q="$1" set="$2"
    r eval "
        local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
        local moved = 0
        for _, id in ipairs(ids) do
            local tkey = KEYS[3] .. id
            if redis.call('EXISTS', tkey) == 1 then
                redis.call('ZREM', KEYS[1], id)
                redis.call('LPUSH', KEYS[2], id)
                redis.call('HSET', tkey, 'state', 'pending', 'pending_since', ARGV[1])
                moved = moved + 1
            else
                -- Index entry whose payload is gone. Nothing can run it; leaving
                -- it in place makes every future status read overcount.
                redis.call('ZREM', KEYS[1], id)
            end
        end
        return moved
    " 3 "$(k "$q" "$set")" "$(k "$q" pending)" "$(k "$q" t:)" "$(date +%s%N)"
}

cmd_retry() {
    local target="${1:-all}"
    confirm "retry requeues every archived and retrying task in '${target}'"
    say "Requeue (installed $(commit))"
    while read -r q; do
        local a r_
        a="$(move_set "$q" archived)"
        r_="$(move_set "$q" retry)"
        printf '  %-10s archived:%-6s retry:%-6s -> pending\n' "$q" "$a" "$r_"
    done < <(expand_queues "$target")
    cmd_status
}

cmd_unstick() {
    local target="${1:-all}"
    say "Orphaned active tasks (lease expired > ${STALE_ACTIVE_SECS}s)"
    local found=0
    while read -r q; do
        local ids; ids="$(stale_active "$q")"
        [ -z "$ids" ] && { printf '  %-10s none\n' "$q"; continue; }
        local n; n="$(printf '%s\n' "$ids" | wc -l)"
        found=$((found + n))
        printf '  %-10s %s stuck\n' "$q" "$n"
        [ "${YES:-0}" = "1" ] || continue
        while read -r id; do
            [ -n "$id" ] || continue
            r eval "
                redis.call('LREM', KEYS[1], 0, ARGV[1])
                redis.call('ZREM', KEYS[2], ARGV[1])
                redis.call('LPUSH', KEYS[3], ARGV[1])
                redis.call('HSET', KEYS[4] .. ARGV[1], 'state', 'pending', 'pending_since', ARGV[2])
                return 1
            " 4 "$(k "$q" active)" "$(k "$q" lease)" "$(k "$q" pending)" "$(k "$q" t:)" \
              "$id" "$(date +%s%N)" >/dev/null
        done <<< "$ids"
        printf '  %-10s %s requeued\n' "$q" "$n"
    done < <(expand_queues "$target")
    [ "$found" -gt 0 ] && [ "${YES:-0}" != "1" ] && \
        echo "  (read-only — re-run with --yes to requeue)"
    return 0
}

cmd_purge() {
    local target="${1:-all}"
    confirm "purge deletes archived tasks permanently; 'retry' can requeue them instead"
    say "Purge archived (installed $(commit))"
    while read -r q; do
        local n=0
        while read -r id; do
            [ -n "$id" ] || continue
            r del "$(k "$q" t:"$id")" >/dev/null
            n=$((n + 1))
        done < <(r zrange "$(k "$q" archived)" 0 -1)
        r del "$(k "$q" archived)" >/dev/null
        printf '  %-10s %s archived tasks deleted\n' "$q" "$n"
    done < <(expand_queues "$target")
}

cmd_doctor() {
    local bad=0
    say "Doctor (installed $(commit))"

    # noeviction is load-bearing, not a preference: under any other policy
    # Redis reclaims memory by deleting keys, and the keys it deletes are as
    # likely to be queued jobs as sessions. A dropped fee reminder leaves no
    # trace anywhere -- the enqueue succeeded.
    local policy; policy="$(r config get maxmemory-policy | tail -1)"
    if [ "$policy" != "noeviction" ]; then
        warn "maxmemory-policy is '${policy}', expected noeviction — queued jobs can be evicted"
        bad=1
    else
        echo "  maxmemory-policy: noeviction"
    fi

    for unit in "${SERVICE}-worker" "${SERVICE}-web"; do
        if systemctl is-active --quiet "$unit"; then
            echo "  ${unit}: active"
        else
            warn "${unit} is not active"
            bad=1
        fi
    done

    for q in "${QUEUES[@]}"; do
        local pending archived stuck
        pending="$(r llen "$(k "$q" pending)")"
        archived="$(r zcard "$(k "$q" archived)")"
        stuck="$(stale_active "$q" | grep -c . || true)"
        if [ "$pending" -gt "${MAX_PENDING[$q]}" ]; then
            warn "${q}: ${pending} pending (threshold ${MAX_PENDING[$q]}) — worker is not keeping up"
            bad=1
        fi
        [ "$archived" -gt 0 ] && { warn "${q}: ${archived} archived — 'failed' to read them, 'retry' to requeue"; bad=1; }
        [ "$stuck" -gt 0 ] && { warn "${q}: ${stuck} orphaned active — 'unstick ${q} --yes'"; bad=1; }
        [ "$(r exists "$(k "$q" paused)")" = "1" ] && { warn "${q} is PAUSED — nothing in it will run"; bad=1; }
    done

    if [ "$bad" = "0" ]; then
        echo "  queues healthy"
    fi
    return "$bad"
}

cmd_restart() {
    say "Restarting ${SERVICE}-worker"
    systemctl restart "${SERVICE}-worker"
    sleep 3
    systemctl is-active "${SERVICE}-worker"
    # A restart alone leaves archived and orphaned tasks exactly where they
    # were, so report the queue afterwards rather than the unit.
    cmd_doctor || true
}

# --- dispatch ---------------------------------------------------------------
ARGS=()
for a in "$@"; do
    case "$a" in
        --yes|-y) YES=1 ;;
        *) ARGS+=("$a") ;;
    esac
done
set -- "${ARGS[@]:-status}"

case "$1" in
    status)  cmd_status ;;
    doctor)  cmd_doctor ;;
    failed)  cmd_failed "${2:-20}" ;;
    retry)   cmd_retry "${2:-all}" ;;
    unstick) cmd_unstick "${2:-all}" ;;
    purge)   cmd_purge "${2:-all}" ;;
    restart) cmd_restart ;;
    *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
