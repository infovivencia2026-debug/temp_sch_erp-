# Hosting on Cloud Run: the target architecture

This is the archived plan for moving the ERP off the single VPS
(`187.127.178.100`, see [scripts/deploy.sh](../scripts/deploy.sh)) onto
Google Cloud Run in Mumbai with managed Postgres, and everything the code
demands that the plan did not know about. The manifests and scripts that
implement it live in [deploy/cloudrun/](../deploy/cloudrun/). Nothing here has
been executed against a real project yet; this document is what to read before
doing so.

## The plan, as given

For a 1,000-student school ERP with light usage, infra can be cheap.

| Component | Estimate (₹/month) |
|---|---|
| Cloud Run backend | 0–300 |
| Neon Postgres | 200–800 |
| Object / file storage | 50–300 |
| Bandwidth | 0–300 |
| Logs / monitoring | 0–200 |
| **Likely total** | **250–1,900** |

Cloud Run charges on usage with a free tier of 2M requests/month.

Realistic example: 1,000 students, 70 staff, 300–500 daily active, homework
posted 1–2×/day, attendance once daily, 5–15 GB files over time:

| Component | ₹/month |
|---|---|
| Cloud Run | 100 |
| Postgres | 400 |
| Files | 100 |
| Network | 100 |
| Monitoring / backups | 100 |
| **≈ total** | **800** |

Neon Launch tier ≈ $0.106 per compute-unit hour, $0.35/GB-month storage,
suspends after inactivity; includes 500 GB/month transfer.

Usage curve: 7 AM some, 9 AM staff, 12 PM low, 3 PM homework posting, 5–8 PM
students, 10 PM+ near zero.

Files must go to object storage with URLs in Postgres, never as blobs, so
Postgres stays under a few GB for years.

Deploy:

```
Students/Teachers → Frontend → Cloud Run (Mumbai, asia-south1) → Neon Postgres → Object Storage (URLs)
```

Settings:

```yaml
min-instances: 0
max-instances: 5
cpu: 1
memory: 512Mi
concurrency: 40-80
```

Don't pay for min-instances 1 yet.

Multi-school economics: 1 school ≈ ₹500–1,500/mo; 5 or 10 schools not 5–10×
the cost; at ₹10/student/month one school yields ₹10,000/mo revenue vs
₹500–1,500 infra, so support, onboarding, SMS/WhatsApp, backups, domains, dev
become the real costs.

## What this codebase needs on top of the plan

The plan describes a stateless web tier over Postgres and a bucket. The code
is nearly that, with seven exceptions, found by reading
[internal/config/config.go](../internal/config/config.go) (every variable the
app reads), [cmd/web/main.go](../cmd/web/main.go),
[cmd/worker/main.go](../cmd/worker/main.go) and the VPS provisioning in
[scripts/deploy.sh](../scripts/deploy.sh).

### (a) Redis is required, and the plan has none

`REDIS_URL` has a default (`redis://127.0.0.1:6379/0`) that points at a Redis
which will not exist on Cloud Run. Both processes open it at boot and fail
without it: the web process creates an asynq client and inspector
(`queue.NewClient`, `queue.NewInspector`) to enqueue jobs and read queue
depth, and the worker is an asynq server. Sessions themselves are in Postgres
(`auth.NewStore(db, …)`); the README's "sessions cache" label is historical,
and the login throttle is deliberately in-memory. So Redis carries exactly one
thing: the job queue and its cron schedule. That one thing is the fee
reminders, the message dispatch, the attendance rollup and the bus-tracker
sweeps.

Recommendation: **Upstash Redis**, region `ap-south-1` (Mumbai) so the round
trip from asia-south1 is a few milliseconds. Requirements the VPS meets today
and Upstash must too:

- `maxmemory-policy noeviction`. deploy.sh checks this and warns; asynq stores
  task payloads in Redis and the default eviction policy would silently drop a
  queued fee reminder under memory pressure. Upstash databases are
  `noeviction` unless you switch on their "Eviction" toggle — leave it off.
- TLS. Upstash gives a `rediss://` URL; asynq v0.25.0 (the pinned version)
  parses that scheme in `asynq.ParseRedisURI`, so `REDIS_URL=rediss://…`
  works with no code change. Keep the logical database at `/0` — Upstash
  exposes one database per instance.
- Lua scripting and the commands asynq uses (`ZADD`, `LMOVE`, `EVALSHA`,
  `SCAN`). Upstash supports all of them; asynq on Upstash is a documented
  combination.

The cost the plan does not have: asynq polls. A worker with four queues
dequeues about once a second per queue, the scheduler heartbeats, and the
web's inspector answers queue-status calls, so an idle system issues on the
order of 300–500 K commands a day. On Upstash pay-as-you-go pricing
(≈ $0.2 per 100 K commands) that is ₹2,000+/month for an empty queue, more
than the whole plan. Take a **fixed-price plan** (the 250 MB tier is around
$10/month with no per-command charge) rather than pay-as-you-go. Memorystore
is the alternative inside Google, but its smallest instance is several times
that and it needs a Serverless VPC connector, which is another line item.

### (b) The worker must be always-on

`cmd/worker/main.go` runs the asynq **scheduler** in the same process as the
consumer. The schedule in
[internal/queue/scheduler.go](../internal/queue/scheduler.go) has entries
every minute (message dispatch), every five (diary reminders, message_log
flush), every fifteen (reminder plans), plus the nightly and weekly ones, and
`RegisterBusTrackerJobs` adds the trip-closing sweeps. A cron that only ticks
while an HTTP request is in flight never fires, so the worker cannot be a
scale-to-zero, CPU-throttled service.

Therefore [service-worker.yaml](../deploy/cloudrun/service-worker.yaml) sets
`minScale: 1`, `maxScale: 1` and `run.googleapis.com/cpu-throttling: "false"`.
Two consequences:

1. **This is the biggest line in the bill.** One vCPU allocated for the whole
   month is ~2.6 M vCPU-seconds; at instance-based pricing that is roughly
   $45–50 ≈ ₹4,000/month before the free tier — several times the plan's
   entire Cloud Run estimate, which assumed request-based billing. The owner
   chose to run it on Cloud Run regardless rather than keep anything on the
   VPS. Two ways to shrink the line later: run it at `cpu: "0.5"` (it is
   Postgres-bound at Concurrency 4 and would barely notice), or convert the
   schedule into Cloud Scheduler → Cloud Run Job invocations so nothing is
   always on. The second is a code change and is what "later" in the plan
   should mean.
2. **Cloud Run needs the worker to listen on `$PORT`.** Every Cloud Run
   service container must accept a TCP connection on its port within the
   startup window. Done: when `PORT` is set, `cmd/worker` opens a small
   listener whose `/healthz` reports the database's health, so the probe
   means "the worker can reach Postgres". With `PORT` unset (systemd on the
   VPS) it opens nothing, as before.

`maxScale: 1` is safe rather than merely cheap: asynq elects one active
scheduler through Redis, so a second replica would consume tasks but add no
schedule, and Concurrency is 4 because the bottleneck is Postgres.

### (c) Files: R2 is already the design; the tiles need a home too

[internal/storage/r2.go](../internal/storage/r2.go) presigns PUTs and GETs
against Cloudflare R2 using `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PRESIGN_EXPIRY`, and `R2_PUBLIC_HOST`
for genuinely public objects such as an institution logo. Object keys are
prefixed with the institution id so a bucket lifecycle rule can be scoped per
tenant. That matches the plan's "URLs in Postgres, never blobs" exactly. What
it needs from the operator:

- Real credentials. The VPS runs with `REPLACE_ME` placeholders
  (`R2Config.Configured()` returns false and presign answers 503).
- A CORS rule on the bucket allowing `PUT` from `BASE_URL`, because browsers
  upload straight to R2 — a 40 MB scanned certificate never passes through
  the Go process.
- A public custom domain on the bucket (`R2_PUBLIC_HOST`), which R2 offers for
  free and which is also where the map tiles go:

**Map tiles.** The bus map reads a self-hosted PMTiles archive. On the VPS it
is `/var/www/temperp-tiles/south-india.pmtiles` (~527 MB) plus fonts and
sprites, served by nginx at `/tiles/` with range requests and
`Access-Control-Allow-Origin: *`. Cloud Run has no disk to put that on and
the SPA is served from the same container as the API, so the archive must
move to the R2 public host.
[web/src/components/FleetMap.tsx](../web/src/components/FleetMap.tsx) reads
everything from one base, `TILES_BASE`, which is `VITE_TILES_BASE` at build
time and `/tiles` when that is unset. For Cloud Run, build the SPA with
`VITE_TILES_BASE=https://<R2_PUBLIC_HOST>/tiles` (there is a commented
example in `web/.env.production`); an absolute base is used as-is for the
archive, fonts and sprites. R2 supports range requests and CORS, which is all
PMTiles needs; the bucket's CORS rule must allow `GET` from the site's origin
as well as the `PUT` for uploads. Uploading is the optional last step of
[scripts/refresh-tiles.sh](../scripts/refresh-tiles.sh): run it on the VPS
with `TILES_R2=1 R2_BUCKET=<bucket>` and either an rclone remote (`R2_REMOTE`,
default `r2`) or the aws cli with `R2_ENDPOINT` set, and it mirrors the
archive, the `BUILD` stamp and `assets/` under `tiles/` in the bucket.

### (d) Neon: TLS in the URLs, and the two roles created by hand

`pgxpool.ParseConfig` passes `sslmode` straight through, and Neon refuses
plaintext, so both URLs need it:

```
DATABASE_URL=postgres://temperp_app:…@ep-….ap-southeast-1.aws.neon.tech/temperp?sslmode=require
MIGRATE_DATABASE_URL=postgres://temperp_owner:…@ep-….ap-southeast-1.aws.neon.tech/temperp?sslmode=require
```

Use Neon's **direct** endpoint, not the `-pooler` one: `internal/database`
sets per-transaction GUCs with `SET LOCAL` and relies on pgx's own pool;
PgBouncer in transaction mode is compatible with `SET LOCAL` but adds a hop
and hides connection counts from the arithmetic below. Neon's smallest
compute allows roughly 100 direct connections; the manifests set the web pool
to 10 × maxScale 5 = 50 and the worker to 4, which leaves room.

**Roles.** The app connects as an unprivileged role so `FORCE ROW LEVEL
SECURITY` applies and so it has no DDL; migrations run as the owner. The
baseline migration deliberately carries no grants (its header says why: each
deployment names its own roles), so the roles and grants below are created by
[scripts/deploy.sh](../scripts/deploy.sh) on the VPS and must be created on
Neon by hand, once, connected as the Neon project owner. This is that SQL
with the VPS's `${SERVICE}=temperp` substituted:

```sql
-- As the Neon project's default (owner) role, on the `temperp` database.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='temperp_owner') THEN
        CREATE ROLE temperp_owner LOGIN PASSWORD '<owner password>';
    ELSE
        ALTER ROLE temperp_owner PASSWORD '<owner password>';
    END IF;
    -- The app connects as this role, never as the owner. Every tenant table
    -- uses FORCE ROW LEVEL SECURITY, so even the owner is subject to the
    -- policies -- but keeping the app unprivileged also denies it DDL.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='temperp_app') THEN
        CREATE ROLE temperp_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE temperp_app PASSWORD '<app password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END $$;

-- deploy.sh does `createdb -O temperp_owner temperp`. On Neon create the
-- database in the console or with:
--   CREATE DATABASE temperp OWNER temperp_owner;
-- then, connected to temperp:

GRANT CONNECT ON DATABASE temperp TO temperp_app;
GRANT USAGE ON SCHEMA public TO temperp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO temperp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO temperp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE temperp_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO temperp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE temperp_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO temperp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE temperp_owner IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO temperp_app;
-- No DDL for the app role.
REVOKE CREATE ON SCHEMA public FROM temperp_app;
```

Two Neon-specific notes. `CREATE ROLE … LOGIN` works from SQL on Neon, but
roles created that way do not appear in the Neon console's role list and are
not managed by it; that is fine, and preferable to console-created roles,
which are members of `neon_superuser` and would defeat the point of the app
role. And `ALTER DEFAULT PRIVILEGES FOR ROLE temperp_owner` only applies to
objects `temperp_owner` creates — so migrations must run as `temperp_owner`
(they do: `MIGRATE_DATABASE_URL`), never as the Neon default role, or new
tables come up without the app grants and every query on them fails with
"permission denied".

Neon also skips the `ALTER SYSTEM` tuning block deploy.sh applies
(`shared_buffers` and friends); Neon manages those, and the block is not
needed.

### (e) `FILE_STORE_DIR` does not exist on Cloud Run

[internal/api/files_local.go](../internal/api/files_local.go) is the
disk-backed upload path added because R2 was never configured: multipart in,
written under `FILE_STORE_DIR` (`/var/lib/temperp/files` on the VPS), served
back as attachments. Cloud Run's filesystem is an in-memory tmpfs that counts
against the 512 Mi and vanishes with the instance, so **every local upload
would be silently lost**. There are three consequences:

1. R2 must be configured before cut-over. It is not optional here as it was
   on the VPS; the manifests set `FILE_STORE_DIR=/tmp/temperp-files` only so
   the path is at least writable and a mistake fails visibly rather than
   with "read-only file system".
2. The files already in `/var/lib/temperp/files` on the VPS have rows in the
   `files` table pointing at local storage. They need copying into the
   bucket and their rows rewriting to the R2 key — a small migration script
   to write when the count is known.
3. Cloud Run's request body limit is 32 MB for HTTP/1 (unlimited when the
   service is set to HTTP/2), below `maxLocalUploadBytes` (64 MB). The R2
   presign path sidesteps this entirely because the browser uploads to R2.

The same applies to `APK_DIR` (`/apps` serves the staff Android builds from
`/var/lib/temperp/apk`) and `FCM_SERVICE_ACCOUNT_FILE` (a JSON file on disk).
`APK_DIR` is handled: the three APKs are checked in under
`web/public/download/` and ship with every web build, and when `APK_DIR` is
unset or empty `/apps` links `/download/<slug>.apk` (served by the Go process
from `WEB_DIST`, by Pages from the edge, or by nginx) and says the build is a
static file, without a version, size or digest -- those come only from a disk
build. `/apps/<slug>.apk` redirects to the static file in that state. Leave
`APK_DIR` unset on Cloud Run. The FCM file becomes a Secret Manager volume,
which the worker manifest carries commented-out until the secret exists.

### (f) Cold starts and the school-day traffic pattern

A cold start of the web container is: pull the image (cached per region),
start a static Go binary, `pgxpool` connect and ping Neon, open Redis, parse
the embedded templates. Expect **1–3 s** with `startup-cpu-boost` on, plus
Neon's own resume if its compute has suspended (Neon suspends after five
minutes idle on the free/Launch tier; resume is a few hundred ms to a couple
of seconds). So the first request of the morning can take 3–5 s; nothing
after it does.

The plan's usage curve (7 AM some, 9 AM staff, …, 10 PM+ near zero) means
Cloud Run scales to zero overnight and comes up once a day. During the day
there is a stronger effect the plan did not know about: the operations live
map (`LiveVehicleMap.tsx`) and the parent's `ChildBus.tsx` poll bus positions
on a server-supplied interval of ~10–20 s while open, and the bus-tracker
apps post positions on a similar cadence. While any bus is running, those
polls alone keep one web instance warm from the first morning route to the
last afternoon drop, so the mid-day trough will not cause cold starts. With
`cpu-throttling: "true"` this costs only the milliseconds each poll takes.

Two things scale-out changes that a single VPS process never had to think
about:

- `httpx.RealIP` used to take the **first** address in `X-Forwarded-For`,
  which a client can forge; every proxy in front of this service (nginx,
  Google's front end) appends the address it saw, so it now takes the
  **last**. Done. Before cut-over,
  take the last hop instead (a one-line change in
  [internal/httpx/middleware.go](../internal/httpx/middleware.go)).
- The login throttle is per process by design, so with `maxScale: 5` an
  attacker gets up to five times the failed attempts. Acceptable at this
  scale; noted so nobody is surprised.

### (g) What stays on the VPS until cut-over

Everything, until the checklist below is complete; and after it, the things
Cloud Run has no equivalent for:

| Stays | Why |
|---|---|
| `temperp-backup.timer` / `scripts/backup-db.sh` | Nightly `pg_dump` to local disk. Neon has point-in-time restore (7 days on Launch), but an off-provider dump is still the one copy Google or Neon cannot lose for you. Point the script at Neon's URL and keep it running on the VPS, or on any box. |
| The assistant (`ragbot.service`, `/assistant/`) | Python + Gemini/ollama on the same host; a separate service with its own hosting decision. `VITE_ASSISTANT_URL` in the SPA build points wherever it lands. |
| The `erp.` sibling deployment | Unrelated to this move. |
| DNS for `temperp.187-127-178-100.sslip.io` | sslip.io encodes the VPS IP; the Cloud Run service needs a real hostname (`BASE_URL`), mapped with a Cloud Run domain mapping or a load balancer. The old hostname can 301 from nginx during the overlap. |
| nginx | Only as a redirect and as the tile server until the archive is on R2. |

## The front end on Cloudflare Pages

The owner's choice for the page itself: Cloudflare Pages, which hosts
`web/dist` on its edge network for nothing, in the same account as the R2
bucket. The Go server stays on Cloud Run (or Fly). What makes this work
without touching the app is that Pages still presents **one origin**:

```
browser ── app.school.in (Pages) ── static files from the edge
                 └── /api/*, /login, /logout, /healthz, /static/*, /iclock/*,
                     /buy, /signup, /forgot, /reset, /apps*, /files/*
                        → web/functions/[[path]].ts → API_ORIGIN (Cloud Run)
```

`web/functions/[[path]].ts` is a Pages Function that forwards those paths to
`API_ORIGIN` and streams the answer back, adding `X-Forwarded-Host`, and
`X-Forwarded-For` in the appending form `httpx.RealIP` expects.
`web/public/_routes.json` limits the Function to exactly those paths, so
static files never invoke it and never count against the Functions free
tier (100,000 requests a day; the API traffic of one school is well under).
`web/public/_headers` carries the same cache and security headers nginx
sends; `web/public/_redirects` maps `/.well-known/assetlinks.json`.

Because the browser only ever talks to the Pages host, the session cookie is
first-party, the fetches are same-origin, and the server-rendered sign-in
pages load at `/login` as they always have. Nothing in `web/src` or the Go
code changes for this.

**Setting it up**

1. Cloudflare dashboard → Workers & Pages → Create → Pages → connect the
   GitHub repository. Root directory `web`, build command
   `npm ci --no-audit --no-fund && npm run build`, output directory `dist`,
   Node version 20 (`NODE_VERSION=20` as a build env var).
2. Environment variable `API_ORIGIN` = the Cloud Run web service URL, no
   trailing slash. Set it for Production and Preview.
3. Custom domain (e.g. `app.<school>.in`) on the Pages project; the DNS is a
   CNAME Cloudflare adds itself when the zone is on Cloudflare.
4. `BASE_URL` on the Cloud Run web service must be the **Pages** URL, not the
   `run.app` one: it is what the server puts in emails and SMS links.
5. The Cloud Run web service can keep `WEB_DIST` set (it then serves the page
   too, harmlessly) or drop it; with Pages in front it is never asked for
   the page. The mobile shells point at the Pages host (`PORTAL_URL` in
   `mobile/apps/parent-ios/Config/Portal.xcconfig` and the Android
   `portalUrl` Gradle property) and need a rebuild for the new host.

**What Pages does not do**: the one place the Go code builds a link from the
request's own `Host` (`internal/api/mod_ops.go`) will see the `run.app`
host behind the proxy; everything else uses `BASE_URL`. Worth switching that
one to `BASE_URL` before cut-over.

## Cut-over checklist

In order. Each step is reversible until step 9.

1. **Code prerequisites** (Go/TS changes, out of scope for the manifests).
   Done alongside the Dockerfile: `cmd/web` serves the SPA from `WEB_DIST`
   and `internal/config` falls back to `PORT`; the worker listens on `$PORT`
   with `/healthz`; `RealIP` takes the last hop. `TILES_BASE` reads
   `VITE_TILES_BASE`, so the R2 public host is a build-time variable, not a
   code change. Merge to `main`.
2. **Accounts.** GCP project with billing, Neon project in `ap-southeast-1`
   (Singapore; Neon has no Mumbai region — ~40 ms from asia-south1, fine for
   this workload), Upstash Redis in `ap-south-1` on a fixed plan, R2 bucket
   with CORS and a public custom domain.
3. **Neon roles and grants.** Run the SQL in (d) as the Neon owner. Create
   the `temperp` database owned by `temperp_owner`.
4. **Secrets.** Copy `PASSWORD_PEPPER`, `SESSION_SECRET`, `CREDENTIAL_KEY`
   from the VPS's `/etc/temperp.env` — they must not change, the pepper
   above all — into `deploy/cloudrun/.env.cloudrun` (gitignored) along with
   the new URLs and the R2 keys. Template:

   ```
   PROJECT_ID=my-gcp-project
   BASE_URL=https://erp.myschool.in
   R2_ACCOUNT_ID=…
   R2_BUCKET=temperp
   R2_PUBLIC_HOST=files.myschool.in
   DATABASE_URL=postgres://temperp_app:…@…neon.tech/temperp?sslmode=require
   MIGRATE_DATABASE_URL=postgres://temperp_owner:…@…neon.tech/temperp?sslmode=require
   REDIS_URL=rediss://default:…@…upstash.io:6379/0
   SESSION_SECRET=<copied from VPS>
   PASSWORD_PEPPER=<copied from VPS>
   CREDENTIAL_KEY=<copied from VPS>
   PAYMENT_GATEWAY_SECRET=<Razorpay key secret, or copy CREDENTIAL_KEY until wired>
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   ```

   Then `bash deploy/cloudrun/secrets.sh`.
5. **Data.** `pg_dump -Fc` the VPS database at a quiet hour with the app in
   maintenance (stop `temperp-web`), `pg_restore --no-owner --role=temperp_owner`
   into Neon as `temperp_owner`. Verify `SELECT count(*) FROM institutions`
   and a sample of `users`. This is the step the schema migrations depend
   on: the goose version table comes across with the dump, so `migrate up`
   afterwards is a no-op unless the image is newer than the VPS.
6. **Files.** Copy `/var/lib/temperp/files` into the bucket under the
   institution-prefixed keys and rewrite the `files` rows. Upload the tiles
   archive, fonts and sprites to the public host and confirm a range request
   returns `206`.
7. **First deploy.** `bash deploy/cloudrun/deploy.sh --dry-run`, read it,
   then without the flag. It builds, migrates (`up`, `seed-permissions`),
   replaces worker then web, and curls `/healthz` on the `run.app` URL.
8. **Smoke test on the `run.app` URL** with every demo role: sign in, load
   the catalog, open a bus on the live map (tiles from R2), upload a file
   (presign to R2), enqueue something and watch the worker log consume it,
   and wait one minute for a `TypeMessageDispatch` tick in the worker log to
   prove the scheduler is alive.
9. **DNS.** Map `BASE_URL`'s hostname to the web service. Point the VPS
   nginx at a 301 to the new host. Sessions do not survive the hostname
   change (the cookie is host-bound); tell the school to expect one sign-in.
10. **Stop the VPS services** — `systemctl disable --now temperp-web
    temperp-worker` — but leave the box, its database and the nightly backup
    running for two weeks. A stopped worker is what makes the rollback below
    clean: the queue is on Upstash now, and two workers on two Redises would
    each run the schedule.
11. **After two weeks:** repoint `backup-db.sh` at Neon (or accept Neon PITR
    plus a weekly manual dump), then decommission the VPS database.

## Rollback

Within the two-week overlap, rollback is DNS plus a restore, and the VPS is
exactly as it was:

1. Point `BASE_URL`'s hostname back at the VPS (or let the school use the
   sslip.io hostname, which never stopped working).
2. `systemctl enable --now temperp-web temperp-worker` on the VPS.
3. Data written on Cloud Run since step 5 lives in Neon, not on the VPS.
   Either accept the gap (announce it) or `pg_dump` Neon and `pg_restore`
   over the VPS database — the schema is identical because both ran the
   same migrations. Files uploaded meanwhile are in R2 and stay reachable
   from the VPS as soon as its `/etc/temperp.env` gets the same R2
   credentials, which it should have anyway.
4. Scale Cloud Run down rather than deleting it: `gcloud run services update
   temperp-worker --min-instances 0` stops the always-on charge, and the
   web service costs nothing at zero traffic. Delete when the second attempt
   is scheduled.

Rolling back a **single bad deploy** on Cloud Run, as opposed to the whole
move, is the platform's strong suit: `gcloud run services update-traffic
temperp-web --to-revisions PREVIOUS=100` in asia-south1, same for the worker.
The image tag is the commit hash, so "which revision" has the same answer it
does on the VPS (`make deploy-server COMMIT=…`). Migrations are the exception,
as they are everywhere: `migrate down` exists, but a downgrade after data has
been written under the new schema is a decision, not a command.
