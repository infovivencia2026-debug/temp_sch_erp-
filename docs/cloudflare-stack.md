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
| `shared/api/` | The API contract: request/response types for the web and the Worker, one file per area (see "Adding or changing an endpoint") |
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

## Testing and deploying

### Running the tests locally

Node 22+ (`export PATH=~/tools/node22/bin:$PATH` on the build boxes).

```
cd worker
npm install --legacy-peer-deps   # once
npm test                         # integration tests, then the node --test suites
npx vitest run                   # integration tests only (~15-20 s)
npx vitest run test/integration/fees.test.ts   # one file
npm run typecheck                # src and tests
npm run test:unit                # scripts/test-provision.sh + scripts/test-billing.sh

cd ../web
npx vitest run                   # plain run (a few known failures, below)
npm run test:ci                  # what CI runs: fails only on unlisted failures
```

**Worker integration tests** (`worker/test/integration/`, config in
`worker/vitest.config.ts`) run the real Worker inside workerd through
`@cloudflare/vitest-pool-workers`: Miniflare gives it local D1, R2, the
queue and the LiveHub Durable Object. Bindings come from
`test/integration/wrangler.test.jsonc`, never from `wrangler.jsonc`, so a
test cannot reach a Cloudflare resource and needs no account. Its
`compatibility_date` trails production's because the bundled workerd only
supports dates up to its own release; raise it when the package is updated.

`fixture.ts` builds CONTROL from `db/control.sql` and the school database
from `db/tenant.sql`, creates the school through the real provisioning code
(`runProvision`, with the D1 API answered by the local binding, so the roles
and permissions are the real seed), then seeds with fixed ids: an admin, a
class teacher, a finance clerk, two parents each with one child in Class 5 A,
Mathematics, a half-yearly exam with one paper, and a Rs 5,000 tuition
invoice per child. Everyone signs in through `GET`/`POST /login` with the
CSRF cookie, like a browser. Each test file gets its own fresh storage, so
files may change data (the subscription gate test suspends the school)
without affecting each other.

| File | Covers |
|---|---|
| `auth.test.ts` | sign-in, wrong password, CSRF, session shape, logout, 401 |
| `students.test.ts` | roll, search, profile, 404, 403 for a parent |
| `attendance.test.ts` | teacher marks the register, correction, parent told, portal view |
| `fees.test.ts` | collect, receipt, ledger balance, dashboard totals add up, invoice paid |
| `exams.test.ts` | marks entry and limits, report cards with ranks, regenerate |
| `access.test.ts` | parent cannot read another family's child, permission 403s, subscription 402 |
| `live.test.ts` | staff chat, the LiveHub SSE `message` event reaching the recipient |
| `background.test.ts` | a job from `POST /jobs` runs on the queue consumer; cron tick baseline then enqueue |

A new route's test: add a file, `beforeAll(seed)`, and use
`api('admin' | 'teacher' | 'finance' | 'parent' | 'otherParent', method, path, body)`.
Anything the seed lacks, insert in the test through `E.TENANT_TEST`.

**Known web failures.** `web/known-test-failures.txt` lists the web tests
that were already red upstream (paint.test "Vivid: mint on card", and four
size-tiers tests; see `docs/audit-2026-09-23.md`). They still run;
`web/scripts/check-test-failures.mjs` fails the build on any failure *not*
in the list and names listed tests that have started passing. Delete a line
when its test is fixed; never add one to hide a new failure.

### What CI does

`.github/workflows/worker.yml`, on every pull request and every push to
`cloudflare-workers` and `main`:

1. **check**: `npm ci` in `worker/` and `web/`; `tsc` for the worker (src and
   tests) and the web; worker integration tests; worker unit tests; web tests
   (known failures allowed); `vite build`. The web build is kept as an
   artifact for the jobs below.
2. **deploy**, on a push to `cloudflare-workers` only, after check passes:
   `wrangler deploy` of the Worker, a `/healthz` check, then the test Pages
   site: `web/dist` plus `web/functions` with a generated `wrangler.toml`
   (`name = "school-erp-d1"`, `API_ORIGIN` = the Worker) deployed to project
   `school-erp-d1`, branch `main`. The repo's `web/wrangler.toml` (project
   `school-erp`, the live site) is never used, and nothing deploys to
   `school-erp`.
3. **preview**, on a pull request from this repository: the PR's web build as
   a Pages branch deployment of `school-erp-d1` (branch `pr-<number>`), against
   the test Worker; the URL is in the run summary. Pull requests from forks
   get only the check, since GitHub gives them no secrets.

A push to `main` is tested but never deployed by this workflow.
`uptime.yml` also probes the Worker's `/healthz` every ten minutes; until
switchover a failure there is a warning and a line in the outage issue, not
an outage by itself (`WORKER_GATES` in that file).

### GitHub secrets

Settings > Secrets and variables > Actions > New repository secret:

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the account id (dashboard, Workers & Pages, right-hand column) |
| `CLOUDFLARE_API_TOKEN` | a token made as below |

The token: My Profile > API Tokens > Create Token > Custom token, with
**Account** permissions on this one account only:

| Permission | Level | Why |
|---|---|---|
| Workers Scripts | Edit | `wrangler deploy` uploads the Worker, its cron trigger and Durable Object migration |
| Cloudflare Pages | Edit | deploys to `school-erp-d1` (production and PR branches) |
| D1 | Edit | `wrangler deploy` checks every `d1_databases` binding |
| Workers R2 Storage | Edit | checks the `r2_buckets` bindings |
| Queues | Edit | attaches the queue consumer |
| Account Settings | Read | lets wrangler look up the account and its workers.dev subdomain |

plus **User > User Details > Read** and **User > Memberships > Read** (wrangler
asks who it is on start). No zone permissions are needed while the Worker is
on workers.dev; add **Zone > Workers Routes > Edit** for the zone if it gets a
route on a custom domain. Set a short expiry and an IP filter if you like;
GitHub's runners have no fixed IPs, so leave that open for CI.

The Worker's own runtime secrets (`PASSWORD_PEPPER`, `CF_API_TOKEN`, ...) stay
in Cloudflare (`wrangler secret put`); `wrangler deploy` keeps them and CI
never sees them.

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

## Adding or changing an endpoint: define it in shared/api first

The web (`web/`) and the Worker (`worker/`) are compiled separately, so a
response shape written down twice drifts: a bare array where the screen reads
`.items`, a renamed field, a `null` where the screen expected the field to be
absent. Each of those was a blank screen. `shared/api/` is the one place the
shape is written, and both sides compile against it.

1. **Declare it.** In the area's file under `shared/api/` (a new area gets a
   new file, exported from `shared/api/index.ts` and added to `interface Api`),
   add the types and a route entry. The key is the method and the path as the
   Worker registers it, without `/api/v1`, with `{placeholders}`:

   ```ts
   export interface StudentsApi {
     'GET /students': { query: StudentListQuery; res: Page<Student> }
     'GET /students/{id}': { res: StudentRecord }
     'POST /students': { body: NewStudent; res: { id: string; admission_no: string } }
   }
   ```

   Lists are `List<T>` (`{items}`) or `Page<T>` (`{items, limit, offset,
   has_more, total?, next_cursor?}`), never a bare array. A field the server
   omits when empty is `x?: T`; one it sends as `null` is `x: T | null`. Match
   the Go handler in `internal/api` when in doubt.

2. **Serve it** with `r.typed` instead of `r.get`/`r.post`. The handler returns
   the body, not a Response, and the compiler checks it against `res`:

   ```ts
   r.typed('GET /students/{id}', 'students.read', async (c): Promise<StudentRecord> => { ... })
   r.typed('POST /students', 'students.write', async (c) => reply({ id, admission_no }, 201))
   ```

   `reply(body, status)` (from `worker/src/router.ts`) sets a status other than
   200; errors are thrown as before (`HttpError`, `badRequest`, ...). Map SQL
   rows explicitly: `optStr`/`opt` (`worker/src/http.ts`) turn NULL into an
   absent field, as Go's `omitempty` does.

3. **Call it** with `api.call` instead of `api.get<T>`:

   ```ts
   api.call('GET /students', { query: { q, limit: 20 } })          // Page<Student>
   api.call('GET /students/{id}', { params: { id } })               // StudentRecord
   api.call('POST /fees/payments', { body: { student_id, amount_paise, mode } })
   ```

   Query values that are `undefined`, `null` or `''` are dropped. Import the
   types from `@shared/api` (or the re-exports in `web/src/lib/api.ts`) rather
   than declaring a local copy in the screen.

Changing a shape is then a compile error on whichever side is behind: run
`cd worker && npx tsc --noEmit` and `cd web && npx tsc --noEmit -p .`.

`node scripts/check-api-contract.mjs` reports coverage: contract routes the
Worker does not serve with `r.typed`, web calls that reach a contract route
through `api.get`/`api.post` instead of `api.call`, and the routes not yet on
the contract, by area (`--all` lists them, `--strict` exits 1 on the first
two). Move a whole area at a time: declare, switch the handlers, switch the
call sites, run both type checks.

The alias is `@shared/*` → `shared/*` in `web/tsconfig.json`,
`web/vite.config.ts` (and `vitest.config.ts`), and `worker/tsconfig.json`;
wrangler's esbuild reads the Worker's tsconfig paths. `shared/api` holds types
only, so it adds nothing to either bundle.

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
