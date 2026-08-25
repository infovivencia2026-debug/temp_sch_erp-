# School ERP

Multi-tenant school ERP: a Go API and worker behind nginx, with a React SPA.

Live: **https://temperp.187-127-178-100.sslip.io**

```
nginx :443 ── TLS, static bundle, reverse proxy
  ├── /api/, /login, /logout, /healthz, /static/  →  temperp-web  :8091
  └── everything else                             →  SPA (/var/www/temperp)

temperp-web      Go, chi, pgx — JSON API + server-rendered auth pages
temperp-worker   Go, asynq    — queue consumer + cron scheduler
PostgreSQL 16    85 tables, RLS on every tenant table
Redis (db 1)     sessions cache + job queue, maxmemory-policy noeviction
```

## Where this came from

The deployed sibling at `erp.187-127-178-100.sslip.io` shipped as three
stripped binaries with no source anywhere on the server, built from a git repo
that had no commits (`vcs.modified=true`, no `vcs.revision`). This tree is a
rebuild on the same stack, from what could be recovered:

| Recovered | How |
|---|---|
| Full schema — 85 tables, 124 indexes, 82 RLS policies, 5 functions | `pg_dump -s` → [migrations/00001_baseline.sql](migrations/00001_baseline.sql) |
| Exact dependency set and versions | `go version -m` on the binary → [go.mod](go.mod) |
| API surface | endpoint strings in the SPA bundle + live probing |
| nginx / systemd / deploy topology | the running configuration |

The original artifacts are preserved under [deployed-snapshot/](deployed-snapshot/),
and the earlier unrelated gin-based scaffold is parked in [_local-scaffold/](_local-scaffold/).

Upstream's 16 incremental migrations were never committed, so the baseline
collapses their end state into one file. It reproduces the production schema
exactly.

## Roles and the feature catalog

[docs/edu_features.csv](docs/edu_features.csv) is the specification: **419 features
across 10 roles and 38 sections**. It is not documentation that sits beside the
code — it *is* the source, generated into both halves of the system:

```
docs/edu_features.csv
  ├─ scripts/gen_catalog.py    → internal/catalog/catalog_gen.go   permission keys, scopes
  │                            → web/src/catalog.gen.ts            shape reference
  ├─ scripts/gen_implemented.py ← web/src/features/registry.ts     what is actually built
  └─ scripts/gen_docs.py       → docs/FEATURES.md                  every feature documented
```

`make docs` regenerates all of it. Never edit a `*_gen.*` file.

Each feature becomes one permission key, `role.section.feature`, seeded into
`permissions` and granted to its role. `GET /api/v1/catalog` returns the
caller's roles, sections and features with `in_scope` and `live` flags, and the
SPA builds its entire navigation from that response — revoking a grant removes
the nav entry on next load, with no client release.

**54 of the 419 have a working screen and endpoint.** The rest are registered,
permissioned, scoped and navigable, and render an explicit "catalogued, not
implemented" page. That is deliberate: a fake dashboard is worse than an empty
one, because nobody can tell it is fake. See
[docs/FEATURES.md](docs/FEATURES.md) for the full table, per role, with the
endpoints behind each built feature.

Demo accounts, one per role, password `Demo@2026pass`:
`super_admin@vivencia.test`, `institution_admin@…`, `hod@…`, `faculty@…`,
`finance@…`, `admissions@…`, `hr@…`, `operations@…`, `student@…`, `parent@…`.
Create them with `make demo`.

## Data scope: RLS is only half of it

RLS answers "which institution?". The catalog needs six narrower boundaries it
cannot express, because they depend on *who* the user is rather than which
tenant they are in:

| Scope | Resolved from | Enforced by |
|---|---|---|
| platform / institution | session | Postgres RLS |
| campus | `user_roles.campus_id` | `internal/scope` predicate |
| department | `departments.head_user_id` | `internal/scope` predicate |
| assigned classes | `section_subject_teachers`, `timetable_entries`, `sections.class_teacher_id` | `internal/scope` predicate |
| self / children | `students.user_id`, `guardians.user_id` | `internal/scope` predicate |

A handler that forgets its scope filter leaks data *within* a tenant, and RLS
will not catch it — every row involved belongs to the same institution, so
`tenant_isolation` admits all of them. [internal/scope](internal/scope/scope.go)
resolves all five sets once per request and returns `FALSE` for an empty set
rather than omitting the clause, so "this teacher has no sections" means no
rows, never all rows.

## Tenancy: read this before writing a query

Every tenant table has `FORCE ROW LEVEL SECURITY` and a policy of the form

```sql
USING (app_is_platform_admin() OR institution_id = app_current_institution())
```

`FORCE` matters: even the table owner is subject to the policies, so there is
no "connect as the owner and see everything" escape hatch. The app connects as
an unprivileged role which additionally has no DDL.

Those helpers read per-transaction GUCs, so **queries must go through
[internal/database](internal/database/db.go)**:

```go
// Normal request path — scoped to the caller's institution.
db.InTenant(ctx, database.Scope{InstitutionID: id.InstitutionID}, func(tx pgx.Tx) error {
    return tx.QueryRow(ctx, `SELECT count(*) FROM students`).Scan(&n)
})

// Bootstrap only: login lookups, session resolve, seeding. Unfiltered by
// tenant, so keep the query narrow.
db.AsPlatform(ctx, func(tx pgx.Tx) error { ... })
```

Scope is set with `SET LOCAL` inside the transaction, so it cannot leak to the
next request that borrows the pooled connection. Forgetting to set it yields
zero rows, never everyone's rows — the safe failure direction. This is covered
by [tests/tenancy_test.go](tests/tenancy_test.go), including cross-tenant read,
update, insert and scope-leak cases.

## Heavy work goes on the queue

Nothing whose cost is unbounded by user input runs inside a request. On a
1 vCPU box, rendering 400 report cards inline stops health checks and nginx
starts 502-ing everyone. `POST /api/v1/jobs` answers **202** with a job id and
a `poll_url`.

Four weighted queues ([internal/queue](internal/queue/queue.go)) — priority is
relative, not strict, so housekeeping still drains while a big import runs:

| Queue | Weight | For |
|---|---|---|
| `critical` | 6 | auth mail, payment webhooks |
| `default` | 3 | interactive work a user is waiting on |
| `bulk` | 2 | imports, exports, report cards, fan-outs |
| `low` | 1 | rollups, session pruning |

Task payloads carry the institution id, so the worker re-establishes the same
RLS scope the request had, and the originating `request_id`, so one identifier
follows a request from nginx into the worker's logs. Fan-outs enqueue one task
per message rather than sending inline — a single task sending 3,000 SMS loses
all progress if it dies at message 2,900.

Cron lives in the worker; asynq elects one active scheduler through Redis, so
scaling to N workers does not produce N copies of every nightly job. Times are
in the institution's timezone, not UTC.

## Layout

```
cmd/{web,worker,migrate}   the three binaries
internal/
  config      env loading and validation
  database    pgx pool + tenant scoping        <- the important one
  httpx       middleware, error envelope, identity
  auth        pepper+bcrypt, sessions, login pages
  rbac        74 permission keys, 19 system roles
  api         /api/v1 handlers
  queue       task types, worker, scheduler, inspector
  storage     Cloudflare R2 presigned uploads
  templates   embedded server-rendered pages
migrations/   goose SQL, embedded into cmd/migrate
web/          Vite + React 18 + Tailwind SPA
scripts/      deploy.sh (runs on the server)
tests/        integration tests (need a database)
```

## Local development

Needs Go 1.25+, Node 22+, PostgreSQL, Redis.

```bash
createdb -O erp_owner school_erp        # see .env.example for the roles
make migrate
make admin EMAIL=you@example.com PASSWORD='at-least-12-chars' INSTITUTION='Your School'
make dev                                # web :8090 + worker
make ui                                 # Vite :5173, proxies /api to :8090
```

`make admin` bootstraps permissions and roles too, so a fresh database needs
one command.

```bash
make test        # unit tests, no database
make test-all    # + RLS integration tests
make test-roles  # role-based end-to-end tests against a running server
make lint        # vet, gofmt, tsc
```

`make test-roles` signs in as all ten demo accounts over the real login form and
asserts: each role sees exactly its own catalog, no role sees another's
features, every narrow scope resolves to a bounded set, each role's endpoints
answer 200 while a student's and parent's attempts at staff endpoints answer
403, a guardian editing `student_id` in the URL gets 404 rather than another
family's child, and everything below `/api/v1` except `/session` is 401 signed
out.

## Deploy

The server builds from git. `make deploy-server` is the supported path;
`make deploy` (cross-compile locally and upload) still works but ships whatever
is in your working tree, which is not something anyone can reproduce later.

```bash
make deploy-server                    # build on the box from origin/main
make deploy-server COMMIT=abc1234     # ship exactly that revision
make deploy-server BRANCH=hotfix      # a different branch
make logs                             # tail both units
make status                           # unit status + https health probe
```

**Deploy rules**

1. **Deploys name a commit.** `COMMIT` pins the revision; without it you get
   whatever `origin/$BRANCH` pointed at that second, and a rollback has no
   command. The hash is stamped into the binary as `main.version` and printed
   at the end of the run.
2. **The commit must be on the branch.** A hash that is not an ancestor of
   `origin/$BRANCH` is refused — otherwise the next ordinary deploy silently
   reverts it, which reads as a fix disappearing from production.
   `ALLOW_OFF_BRANCH=1` overrides it for a genuine emergency.
3. **Migrations run before the binaries swap.** A failed migration leaves the
   old binaries serving: a failed deploy rather than an outage.
4. **A deploy owns the queue it disturbs.** Restarting the worker orphans
   whatever it was running — those tasks sit in asynq's `active` list with a
   dead lease and are never picked up again. The deploy requeues them and then
   reports queue health; a queue that was already unhealthy is printed loudly
   but does not fail the run, because by then the new binaries are live.

### Queue maintenance

The deploy repairs what it broke. Everything else is
[scripts/queue-maint.sh](scripts/queue-maint.sh), run over ssh:

```bash
make queue-status              # depths per queue: pending/active/scheduled/retry/archived
make queue-doctor              # health verdict; non-zero exit if unhealthy
make queue-failed N=50         # archived tasks and the errors that killed them
make queue-retry Q=bulk        # archived + retrying -> pending
make queue-unstick             # tasks orphaned by a worker restart -> pending
make queue-restart             # restart the worker, then report
```

Reads are safe; anything that mutates needs `--yes`. `retry` is preferred over
`purge` — purge deletes payloads that are the only copy of the job.

`make deploy FQDN=erp.yourschool.com SERVICE=yourschool` retargets it.
Everything is namespaced by `$SERVICE` — port, database, roles, unit names,
nginx site, webroot — which is how this runs alongside the original ERP on the
same box without collision.

[scripts/deploy.sh](scripts/deploy.sh) is idempotent: re-running upgrades
binaries, applies migrations and restarts, preserving data and secrets.
`PASSWORD_PEPPER` is generated once and never rewritten — changing it
invalidates every stored password.

## Known gaps

- **R2 is unconfigured.** `R2_ACCOUNT_ID` and friends are `REPLACE_ME`, so
  `/api/v1/files/presign` returns 503 with an explicit reason. The service
  starts anyway: an unconfigured bucket should not take the whole ERP down.
  (The original deployment claims in a comment that it refuses to boot without
  these, but it has been running with placeholders since 14 Aug.)
- **Login identifiers are ambiguous across tenants.** Email and phone are
  unique *per institution*, and the sign-in form has no tenant selector. Rather
  than guess, an identifier matching users in more than one institution is
  rejected and logged. A second tenant needs hostname-based resolution first.
- **365 of 419 catalogued features have no screen yet.** They are registered
  with a permission key and data scope and render an explicit placeholder.
  [docs/FEATURES.md](docs/FEATURES.md) marks each one.
- **Legacy note, since fixed:** the first baseline generator stripped every line
  starting with `SET `, which deleted `SET allocated_paise = COALESCE(` from
  inside `sync_payment_allocated`. Because the baseline runs with
  `check_function_bodies = false`, the broken function was accepted at CREATE
  time and failed only when a payment allocation was inserted. The generator is
  now dollar-quote aware and
  [migration 00002](migrations/00002_fix_payment_allocation_trigger.sql) repairs
  databases built before the fix.
