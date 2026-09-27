# The Cloudflare stack: Workers + D1

The ERP backend is moving from Go on Cloud Run with Neon Postgres to a
TypeScript Cloudflare Worker with D1 databases. This is what you need to run,
change and deploy it.

**Status (2026-09-26).** The Worker is complete and live for testing. **Production
still runs on Cloud Run + Neon** until the switchover (last section). Do not
point the live site at the Worker without running the switchover script.

| | URL |
|---|---|
| Worker (API) | https://school-erp.infovivencia2026.workers.dev |
| Test site (Pages, talks to the Worker) | https://school-erp-d1.pages.dev |
| Live site (Pages, still talks to Cloud Run) | https://school-erp-cqj.pages.dev |

Cloudflare account: `654ba212c64772676db80c1abf1499f8` (Workers Paid plan).
Ask the owner to invite you as a member with Workers, D1, R2, Pages and Queues
access.

## Architecture

```
Browser ─▶ Pages (web/, React)  ─ web/functions/[[path]].ts proxies server paths ─▶ Worker (worker/)
                                                                                    │
                     ┌──────────────────────────────────────────────────────────────┤
                     ▼                    ▼                       ▼                 ▼
          D1: school-erp-control   D1: one per school      R2: file buckets   Queue + Cron + Durable Object
          (schools, plans,         (all school data,       FILES (read)       jobs, schedules,
           subscriptions,           same schema each)      FILES_WRITE        live updates (LiveHub)
           sessions, sign-in index)
```

- **One database per school.** Isolation is the database boundary. The Go
  server used Postgres row-level security; D1 has none, so a query can only
  ever see the school whose database it runs on.
- **CONTROL database** holds what a request needs before it knows the school:
  institutions (with each school's `d1_binding`), plans, subscriptions,
  platform staff and roles, sessions, the sign-in index (`login_index`), jobs.
- Each school database is a Worker binding named `TENANT_<SLUG>` in
  `worker/wrangler.jsonc`, recorded on the school's CONTROL row. A request
  resolves its school once (`src/identity.ts`, `src/tenant.ts`).
- The web app (`web/`) is unchanged. Pages proxies `/api/`, `/login`,
  `/logout`, `/forgot`, `/reset`, `/signup`, `/buy`, `/apps`, `/files/` to
  `API_ORIGIN` (set in `web/wrangler.toml` for the live project).

## Repository layout

| Path | What |
|---|---|
| `worker/src/index.ts` | Entry: device/public handlers, pages, auth gates, the route table, `queue()` and `scheduled()` handlers, exports `LiveHub` |
| `worker/src/routes/` | API routes, one module per Go handler group, registered in `routes/index.ts` (1,411 routes) |
| `worker/src/pages/` | Server-rendered pages (sign-in, forgot/reset, buy, signup, apps, MFA), HTML captured from the Go templates |
| `worker/src/services/` | files (R2), messaging (SMS/email/WhatsApp/push), jobs (Queues), cron, live (Durable Object), pdf, xlsx |
| `worker/src/gates.ts`, `idempotency.ts` | Password-change, subscription and section gates; duplicate-request protection |
| `worker/migrations/` | Schema migrations (control, tenant); `scripts/migrate.mjs` |
| `worker/db/control.sql` | CONTROL schema, **generated** from the migrations by `scripts/schema-sync.mjs` |
| `worker/db/tenant.sql` | Per-school schema, **generated** from the migrations (baseline from Postgres via `scripts/d1/pg_to_d1.py`) |
| `worker/PORTING.md` | The rules every ported route follows (read before changing routes) |
| `scripts/d1/pg_to_d1.py` | Postgres → SQLite schema + data export (optionally one school) |
| `scripts/d1/split_big.py` | Makes an export fit D1 (100 KB statements, self-references, re-runnable) |
| `worker/scripts/` | `provision-school.sh`, `load-production.sh`, `switchover.sh`, `lib-load.sh` |

## Setup

```
export PATH="$HOME/tools/node22/bin:$PATH"   # Node 22; any Node 22 install works
cd worker
npm install --legacy-peer-deps
npx wrangler login                            # Cloudflare account above
npx tsc --noEmit                              # must be clean before any deploy
```

## Deploy

```
cd worker
npx tsc --noEmit
npx wrangler deploy
```

That deploys the API, the queue consumer, the every-minute cron and the
Durable Object. Check afterwards:

```
curl -s https://school-erp.infovivencia2026.workers.dev/healthz        # ok
npx wrangler tail --format pretty                                       # live logs
```

The **test web site** is deployed from a build of `web/` with
`API_ORIGIN` pointing at the Worker (project `school-erp-d1`):

```
cd web && npm run build
# deploy dist/ + functions/ with a wrangler.toml whose name is school-erp-d1
# and [vars] API_ORIGIN = "https://school-erp.infovivencia2026.workers.dev"
npx wrangler pages deploy --branch main
```

Never deploy that config to the `school-erp` Pages project; that is the live
site and it builds from git.

## Configuration

Bindings (in `worker/wrangler.jsonc`):

| Binding | What |
|---|---|
| `CONTROL` | D1 `school-erp-control` |
| `TENANT_YAJUR`, `TENANT_JSM`, … | D1 per school (names carry a load timestamp, e.g. `school-erp-yajur-202609261728`) |
| `FILES` | R2 `school-erp`, the live bucket the Go server uses. **Read only** until switchover |
| `FILES_WRITE` | R2 `school-erp-d1-uploads`, where uploads/deletes go until switchover; then set to `school-erp` |
| `JOBS` | Queue `school-erp-jobs` (dead letters: `school-erp-jobs-dlq`) |
| `LIVE` | Durable Object `LiveHub`, one per school, for `/api/v1/live/stream` |
| cron | `* * * * *`; `src/services/cron.ts` decides what runs when, in each school's timezone |

Secrets (`npx wrangler secret put NAME`; values are the Cloud Run ones, from
Google Secret Manager / `deploy/cloudrun/.env.cloudrun`):

| Secret | Why |
|---|---|
| `PASSWORD_PEPPER` | Must equal Cloud Run's, or no stored password verifies |
| `CREDENTIAL_KEY` | Decrypts stored provider credentials (SMS, email, payment, Tally) |
| `SESSION_SECRET` | Signs public test-message links |
| `FCM_SERVICE_ACCOUNT` | Firebase service-account JSON; push is off without it |
| `PLATFORM_PROVIDERS`, `RESEND_API_KEY` | Optional fallbacks; platform messaging normally uses the shared provider rows |

Local development uses `worker/.dev.vars` (gitignored) for the same names.

## Local development

```
cd worker
npx wrangler d1 execute CONTROL --local --file=db/control.sql
scripts/provision-school.sh demo "Demo School" "Demo" --local
npx wrangler dev                       # http://localhost:8787
```

Use `--persist-to <dir>` to keep separate local states. `wrangler dev
--test-scheduled` lets you trigger the cron with `/__scheduled`.

## Common tasks

**Add a school.** Seller → Schools → New school. The console queues the
`school:provision` job (`worker/src/services/provision.ts`), which creates the
D1 database through the Cloudflare API, applies `db/tenant.sql` in chunks,
seeds roles, permissions, campus and administrator, then writes the CONTROL
rows (institution, subscription, `login_index`). Progress is in
`CONTROL.provisioning`; a failure shows its stage and error with Retry and
Discard. No deploy is needed: until the Worker has the school's
`TENANT_<SLUG>` binding, `src/tenant.ts` reaches it over the D1 HTTP API.
Run `worker/scripts/provision-school.sh --attach` then `npx wrangler deploy`
from time to time so such schools get a native binding (faster). Needs the
Worker secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN` (Account > D1 > Edit) and
control migration `0007_provisioning` applied to CONTROL. Tests:
`worker/scripts/test-provision.sh`.

`worker/scripts/provision-school.sh <slug> "<Name>" "<Short>"` still works
for local development (`--local`): it creates the database, applies the schema,
adds the binding and the CONTROL row, but no administrator or roles; then
`npx wrangler deploy`.

**Change the schema.** Migrations live in `worker/migrations/control/` (the
CONTROL database) and `worker/migrations/tenant/` (every school database) as
`NNNN_name.sql`: numbered, forward-only, re-runnable where SQLite allows
(`IF NOT EXISTS`, `INSERT OR IGNORE`; `ALTER TABLE ... ADD COLUMN` cannot be,
the tracking table guards it). Each database records what it has applied in
`_migrations(scope, version, name, checksum, applied_at)`; editing an applied
file is a checksum error, so fix mistakes with a new migration.

```
cd worker
npm run migrate -- new tenant add_widget_colour   # writes migrations/tenant/NNNN_add_widget_colour.sql
# edit it, then:
npm run schema:sync                               # rebuilds db/control.sql, db/tenant.sql, src/services/tenant_migrations.ts
npm run test:migrate
npm run migrate -- up --local                     # try it on the local D1
npm run migrate -- status --remote                # applied / pending per database
npm run migrate -- up --remote --dry-run
npm run migrate -- up --remote                    # CONTROL, then every school
git add migrations db src/services/tenant_migrations.ts && git commit
```

`up` applies CONTROL first, then the schools in slug order (from
`CONTROL.institutions`), at most `--limit` (default 25) schools with pending
work per run; it stops at the first failure, names the school, and resumes
from there on the next run. `up --school <slug>` does one school and leaves
CONTROL alone. A school with a binding in `wrangler.jsonc` goes through
`wrangler d1 execute`; one without (created from Tenants → New school, not yet
deployed) goes over the D1 HTTP API with `CF_ACCOUNT_ID` and `CF_API_TOKEN` in
the environment. `--local` (the default) reaches bound databases only.

`db/control.sql` and `db/tenant.sql` are **generated** (do not edit): the
schema and seed rows after applying every migration to an empty SQLite
database, with the migrations recorded as applied. A new school is loaded from
`db/tenant.sql`, and provisioning then records every tenant migration
(`src/services/tenant_migrations.ts`), so new schools always match.
`npm run schema:check` fails if they are stale.

`db/changes/00343-00346` are data-only fixes applied to every school before
the runner existed; they are history and are not migrations. The former
`db/changes/control_*.sql` are control migrations 0002-0009.

**One-time, for databases that predate the runner** (they already have
everything; this only writes `_migrations`, it runs no migration):

```
npm run migrate -- mark-applied --remote --scope control --through 9
npm run migrate -- mark-applied --remote --scope tenant --through 1
npm run migrate -- status --remote
```

`up` refuses a database that has tables but no `_migrations`, so it can never
run a baseline over live data.

**Add or change a route.** Follow `worker/PORTING.md`. Register in the domain
module; literal paths before `{id}` paths; permission key per route.

## D1 rules that bite

- **At most 100 bound parameters per statement.** Pass id lists as one JSON
  array: `col IN (SELECT value FROM json_each(?))` with `JSON.stringify(ids)`.
- **At most 100 KB per statement.** Large values must be written in pieces.
- **No interactive transactions.** Use `db.batch([...])` for atomic writes;
  reads happen before the batch.
- **Foreign keys are checked per statement.** Insert parents before children.
- **No row-level security.** Each school database also contains *shared rows*
  (`institution_id IS NULL`: system roles, platform provider credentials,
  platform audit rows). School-facing queries on those tables must filter
  `institution_id = ?` / `IS NOT NULL`.
- **Types.** uuid/timestamps/numeric are TEXT (timestamps ISO-8601 UTC),
  booleans INTEGER 0/1, arrays and jsonb are JSON text. Money stays TEXT/paise.
- **Free-plan write limit** (100k rows/day) breaks everything; the account is
  on Workers Paid, keep it there.

## Data loading and switchover

- `worker/scripts/load-production.sh`: loads a read-only per-school export
  into fresh stamped databases, repoints the bindings, fills CONTROL, copies
  platform staff and roles, sets `PASSWORD_PEPPER`, deploys. Test data today is
  a snapshot of Neon taken 2026-09-26 16:21 IST.
- `worker/scripts/switchover.sh`: the production cutover, step by step with a
  confirmation at each: pre-checks, write pause, fresh `pg_dump` snapshot,
  per-school load, row-count verification against the snapshot, files bucket
  switch, `API_ORIGIN` change on the live Pages project, post-checks, and the
  rollback (revert `API_ORIGIN`; Neon stays untouched).
- Details: `docs/d1-migration.md`.

## Known differences from the Go server

- Pushes go out within about a minute (cron granularity), not 5 seconds.
- Error bodies are `{error, code}` rather than Go's nested `{error:{code,message}}`
  (public/device routes keep Go's shape).
- `POST /files/presign` answers 503 (the app uploads through `POST /files`).
- WhatsApp template submission to Meta and board-member switching across
  schools are not ported.
- Brute-force limits missing in Go are also missing here: bus driver sign-in,
  `/session/reauth`, `/forgot`.
