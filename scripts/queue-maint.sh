#!/usr/bin/env bash
# Queue maintenance for the ${SERVICE} River queues. Runs ON the server.
#
# The queue is River (github.com/riverqueue/river): every job is a row in
# river_job, in the application's own Postgres, so this script is psql against
# that table and nothing else. It used to be redis-cli against asynq's key
# layout; the commands and their names are unchanged so the Makefile targets
# and the deploy still work the same way.
#
# Deploys restart the worker; they do not repair the queue. When a bad build
# ships, the damage outlives it: jobs that panicked until they ran out of
# attempts are `discarded`, jobs the dead worker was holding are `running`
# with nobody behind them (River's own rescuer returns those to `available`
# after 45 minutes -- RescueStuckJobsAfter -- which is longer than a deploy
# wants to wait), and `retryable` is full of jobs backing off against an error
# that was fixed three commits ago. Restarting the worker fixes none of that
# at once, which is why "the deploy went green and the queue is still dead" is
# the normal way this goes wrong.
#
# This is the repair path. Everything reads first and mutates only when asked,
# and every mutation names the commit it was run against, so a queue that gets
# drained by hand leaves a trace in the journal.
#
#   bash queue-maint.sh status                  # depths per queue
#   bash queue-maint.sh doctor                  # read-only health verdict, exit 1 if unhealthy
#   bash queue-maint.sh failed [N]              # what gave up, and why
#   bash queue-maint.sh retry <queue> --yes     # discarded+cancelled+retryable -> available
#   bash queue-maint.sh unstick <queue> --yes   # orphaned running -> available
#   bash queue-maint.sh purge <queue> --yes     # delete discarded/cancelled rows for good
#   bash queue-maint.sh restart                 # restart the worker, then doctor
#
# Queue names: critical | default | bulk | low | all
#
# Vocabulary: the columns use the names the SPA and the older tooling use --
# pending/active/scheduled/retry/archived -- which map onto River's states as
# available/running/scheduled/retryable/discarded+cancelled (the same mapping
# internal/queue/inspect.go makes for the API).
set -euo pipefail

SERVICE="${SERVICE:-temperp}"
ENV_FILE="${ENV_FILE:-/etc/${SERVICE}.env}"
SRC="${SRC:-/opt/${SERVICE}-src}"
QUEUES=(critical default bulk low)

# Depth at which a queue is called unhealthy rather than busy. Bulk is allowed
# a real backlog -- a 5,000-row import is one enqueue and a long tail -- while
# anything sitting in critical is a password reset nobody received.
declare -A MAX_PENDING=([critical]=50 [default]=500 [bulk]=5000 [low]=2000)
# A running job older than this has no live worker behind it. The longest
# timeout the code hands out is 30 minutes and River's rescuer fires at 45;
# this sits between the two so a genuinely long job is never mistaken for a
# corpse, and a deploy does not have to wait the full 45.
STALE_ACTIVE_SECS="${STALE_ACTIVE_SECS:-2100}"

say()  { printf '\n=== %s ===\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

# --- database ---------------------------------------------------------------
# DATABASE_URL in the env file is the app role's connection, and the app role
# can read and write river_job (00042's default privileges; River's tables are
# created by the owner through goose like every other table). Reading the URL
# from the file rather than assuming a name is what keeps this script pointed
# at the deployment it was asked about when two share the box.
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (run as root on the server)"
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DATABASE_URL" ] || die "no DATABASE_URL in $ENV_FILE"
command -v psql >/dev/null || die "psql not installed"

# q <sql> -- one query, unaligned, tuples only, one value or row per line.
q() { psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

q "SELECT 1 FROM river_job LIMIT 0" >/dev/null 2>&1 \
    || die "cannot read river_job (is the database up and migration 00250 applied?)"

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

# count <queue> <state...> -- rows in the queue in any of the given River states.
count() {
    local qn="$1"; shift
    local list; list="$(printf "'%s'," "$@")"; list="${list%,}"
    q "SELECT count(*) FROM river_job WHERE queue = '${qn}' AND state IN (${list})"
}

# stale_active <queue> -- ids of running jobs whose attempt started more than
# STALE_ACTIVE_SECS ago. These are the jobs a killed worker was holding; River
# will rescue them itself eventually, this just does not wait.
stale_active() {
    q "SELECT id FROM river_job
        WHERE queue = '$1' AND state = 'running'
          AND attempted_at < now() - interval '${STALE_ACTIVE_SECS} seconds'
        ORDER BY id"
}

paused() {
    q "SELECT count(*) FROM river_queue WHERE name = '$1' AND paused_at IS NOT NULL"
}

# --- commands ---------------------------------------------------------------

cmd_status() {
    say "Queues (river_job, installed $(commit))"
    printf '  %-10s %8s %8s %10s %8s %9s %8s\n' \
        queue pending active scheduled retry archived paused
    for qn in "${QUEUES[@]}"; do
        local p=no
        [ "$(paused "$qn")" != "0" ] && p=YES
        printf '  %-10s %8s %8s %10s %8s %9s %8s\n' "$qn" \
            "$(count "$qn" available)" \
            "$(count "$qn" running)" \
            "$(count "$qn" scheduled pending)" \
            "$(count "$qn" retryable)" \
            "$(count "$qn" discarded cancelled)" \
            "$p"
    done
    echo
    printf '  worker: %s   web: %s\n' \
        "$(systemctl is-active "${SERVICE}-worker" 2>/dev/null || echo unknown)" \
        "$(systemctl is-active "${SERVICE}-web" 2>/dev/null || echo unknown)"
}

cmd_failed() {
    local limit="${1:-20}"
    for qn in "${QUEUES[@]}"; do
        local n; n="$(count "$qn" discarded cancelled)"
        [ "$n" = "0" ] && continue
        say "gave up in ${qn} (${n} total, showing ${limit})"
        # errors is an array of {at, attempt, error, trace}; the last element
        # is the one that ended it. A trace is too long for 3am; the message
        # is the field worth reading.
        q "SELECT id || '  ' || kind || '  ' || state || '  attempt ' || attempt || '/' || max_attempts
                  || E'\n      at:  ' || coalesce(finalized_at::text, '')
                  || E'\n      err: ' || coalesce(left((errors[array_length(errors, 1)])->>'error', 200), '(none recorded)')
             FROM river_job
            WHERE queue = '${qn}' AND state IN ('discarded', 'cancelled')
            ORDER BY finalized_at DESC
            LIMIT ${limit}" | sed 's/^/  /'
    done
}

# requeue <queue> <state...> -- back to available, now. Mirrors River's own
# JobRetry: the job becomes available immediately, and a job that used every
# attempt gets one more so the worker does not discard it again on sight.
# One UPDATE, so a shell dying half-way leaves rows either moved or not.
requeue() {
    local qn="$1"; shift
    local list; list="$(printf "'%s'," "$@")"; list="${list%,}"
    q "WITH moved AS (
           UPDATE river_job
              SET state = 'available',
                  scheduled_at = now(),
                  finalized_at = NULL,
                  max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END,
                  metadata = metadata || jsonb_build_object('requeued_by', 'queue-maint@$(commit)', 'requeued_at', now())
            WHERE queue = '${qn}' AND state IN (${list})
            RETURNING 1)
       SELECT count(*) FROM moved"
}

cmd_retry() {
    local target="${1:-all}"
    confirm "retry requeues every discarded, cancelled and retryable job in '${target}'"
    say "Requeue (installed $(commit))"
    while read -r qn; do
        local a r_
        a="$(requeue "$qn" discarded cancelled)"
        r_="$(requeue "$qn" retryable)"
        printf '  %-10s archived:%-6s retry:%-6s -> pending\n' "$qn" "$a" "$r_"
    done < <(expand_queues "$target")
    cmd_status
}

cmd_unstick() {
    local target="${1:-all}"
    say "Orphaned running jobs (started > ${STALE_ACTIVE_SECS}s ago)"
    local found=0
    while read -r qn; do
        local ids; ids="$(stale_active "$qn")"
        [ -z "$ids" ] && { printf '  %-10s none\n' "$qn"; continue; }
        local n; n="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
        found=$((found + n))
        printf '  %-10s %s stuck\n' "$qn" "$n"
        [ "${YES:-0}" = "1" ] || continue
        local moved
        moved="$(q "WITH moved AS (
                UPDATE river_job
                   SET state = 'available', scheduled_at = now(),
                       metadata = metadata || jsonb_build_object('unstuck_by', 'queue-maint@$(commit)', 'unstuck_at', now())
                 WHERE queue = '${qn}' AND state = 'running'
                   AND attempted_at < now() - interval '${STALE_ACTIVE_SECS} seconds'
                 RETURNING 1)
            SELECT count(*) FROM moved")"
        printf '  %-10s %s requeued\n' "$qn" "$moved"
    done < <(expand_queues "$target")
    [ "$found" -gt 0 ] && [ "${YES:-0}" != "1" ] && \
        echo "  (read-only — re-run with --yes to requeue)"
    return 0
}

cmd_purge() {
    local target="${1:-all}"
    confirm "purge deletes discarded and cancelled jobs permanently; 'retry' can requeue them instead"
    say "Purge archived (installed $(commit))"
    while read -r qn; do
        local n
        n="$(q "WITH gone AS (
                DELETE FROM river_job
                 WHERE queue = '${qn}' AND state IN ('discarded', 'cancelled')
                 RETURNING 1)
            SELECT count(*) FROM gone")"
        printf '  %-10s %s archived jobs deleted\n' "$qn" "$n"
    done < <(expand_queues "$target")
}

cmd_doctor() {
    local bad=0
    say "Doctor (installed $(commit))"

    # Nothing to check about eviction any more: a row in Postgres stays until
    # something deletes it. What can still go wrong is the units and the
    # backlog.
    for unit in "${SERVICE}-worker" "${SERVICE}-web"; do
        if systemctl is-active --quiet "$unit"; then
            echo "  ${unit}: active"
        else
            warn "${unit} is not active"
            bad=1
        fi
    done

    for qn in "${QUEUES[@]}"; do
        local pending archived stuck
        pending="$(count "$qn" available)"
        archived="$(count "$qn" discarded cancelled)"
        stuck="$(stale_active "$qn" | grep -c . || true)"
        if [ "$pending" -gt "${MAX_PENDING[$qn]}" ]; then
            warn "${qn}: ${pending} pending (threshold ${MAX_PENDING[$qn]}) — worker is not keeping up"
            bad=1
        fi
        [ "$archived" -gt 0 ] && { warn "${qn}: ${archived} gave up — 'failed' to read them, 'retry' to requeue"; bad=1; }
        [ "$stuck" -gt 0 ] && { warn "${qn}: ${stuck} orphaned running — 'unstick ${qn} --yes'"; bad=1; }
        [ "$(paused "$qn")" != "0" ] && { warn "${qn} is PAUSED — nothing in it will run"; bad=1; }
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
    # A restart alone leaves discarded and orphaned jobs exactly where they
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
    *) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
