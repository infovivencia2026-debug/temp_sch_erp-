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

### (a) Redis was required; River removed the requirement

*Superseded by commit a45d9ca (2026-09-05), kept as the record of a decision.*

When this was written, `REDIS_URL` defaulted to `redis://127.0.0.1:6379/0`,
both processes opened it at boot and failed without it: the web process
created an asynq client and inspector to enqueue jobs and read queue depth,
and the worker was an asynq server. Sessions were already in Postgres, the
login throttle in memory, so Redis carried exactly one thing -- the job queue
and its cron schedule -- and the recommendation here was an Upstash Redis in
`ap-south-1` on a fixed-price plan, with `noeviction` and TLS, because asynq
polled several hundred thousand commands a day even when idle.

That is no longer the situation. The queue is
[River](https://github.com/riverqueue/river): jobs are rows in `river_job`,
in the same database as everything else (migration `00250_river_queue.sql`),
the web process holds an insert-only client, the worker holds the producers,
and `REDIS_URL` is read by `internal/config` and ignored, with one log line at
boot if it is set. No Redis account, no eviction policy, no per-command bill.
The manifests carry no `temperp-redis-url` secret.

### (b) The worker must be always-on -- so there is no worker

When this was written, `cmd/worker/main.go` ran the asynq **scheduler** in the
same process as the consumer, so the worker had to stay up for cron to happen.
Under River the schedule ([internal/queue/cron.go](../internal/queue/cron.go);
entries every minute for message dispatch, every five for diary reminders and
the message_log flush, every fifteen for reminder plans, the nightly and weekly
ones, and `RegisterBusTrackerJobs`' trip-closing sweeps) is evaluated by
`GET /api/v1/cron` with `X-Cron-Key`, remembering each entry's last run in
`cron_runs`; Cloud Scheduler calls it every minute and the worker only works
jobs. On the VPS the worker still ticks in-process (`CRON_INPROCESS=1`).

What would still keep a worker always-on is not cron but wake-up: River hands
jobs to a worker over Postgres `LISTEN/NOTIFY` (with polling as fallback), and
Cloud Run does not start a container for a database notification. A worker
service at `minScale: 0` works nothing; at `minScale: 1` with CPU always
allocated it is ~2.6 M vCPU-seconds a month, roughly $45–50 ≈ ₹4,000 before
the free tier — several times the plan's entire Cloud Run estimate.

So the default design deploys **no worker**. The web service sets
`QUEUE_INPROCESS=1` ([cmd/web/main.go](../cmd/web/main.go)): it registers the
same handlers `cmd/worker` does and runs River's producers, so whichever
instance is awake works the queue. What keeps one awake is the same thing that
ticks cron: Cloud Scheduler calls `/api/v1/cron` every minute, and that request
is when the queue is looked at overnight; during the day the bus-position
polls do it. The trade-off, spelled out in the header of
[service-web.yaml](../deploy/cloudrun/service-web.yaml): with
`cpu-throttling: "true"` a job that outlives the request that woke the
instance runs on a throttled CPU until the next request — acceptable for a
queue whose handlers are a few SQL statements and a few gateway calls, with
the minute tick bounding the stall — and a heavy job shares the instance with
users' requests (the fee fan-out is already chunked). Every instance is also a
worker and opens River's own pool (12 workers + 4), which is why `maxScale` is
3 and `DB_MAX_CONNS` 8: 3 × (8 + 16) = 72 connections at full fan-out, under
Neon's ~100. The limiters are shared through Postgres
(`RATE_LIMIT_STORE=postgres`) so three instances agree on a login throttle.

[service-worker.yaml](../deploy/cloudrun/service-worker.yaml) is kept as the
**optional, paid** second service, applied only by `deploy.sh --with-worker`.
Its header says when to pay for it; today there is exactly one reason: the
push pump to the parent app (`RunPushPump`, FCM) runs in `cmd/worker` and not
in `cmd/web`, so notifications exist only while that service does. Until push
moves into the web process or a cron entry, a school that wants push pays the
₹4,000, and a school that does not, does not. It is safe beside the in-process
workers — River leases each job to one consumer, and cron serialises on an
advisory lock — and `CRON_INPROCESS` is unset on it, so it is a second
consumer and never a second clock. When `PORT` is set it answers `/healthz`
with the database's and the queue's health, which Cloud Run requires of every
service container.

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
compute allows roughly 100 direct connections, and the web manifest is sized
to it: per instance the app pool (8) plus the
in-process River pool (16), times maxScale 3 = 72, plus 20 for the optional
worker, which leaves room.

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
start a static Go binary, `pgxpool` connect and ping Neon, build River's
insert-only client (no connection of its own), parse
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
  **last**. Done. With Cloudflare Pages in front, the last hop is a
  Cloudflare edge, so `CF-Connecting-IP` wins when present — and because
  anyone who finds the `run.app` URL can send that header too, it is believed
  only when the request also carries `X-Origin-Secret` equal to
  `ORIGIN_SHARED_SECRET`, which the Pages Function adds from its own variable
  of the same name ([internal/httpx/middleware.go](../internal/httpx/middleware.go)).
  Both sides optional: unset on the Go side means "believe the header", which
  is right for the VPS where Cloudflare is not in the path. Set it on Cloud
  Run (secret `temperp-origin-shared-secret`, block commented in
  `service-web.yaml`) and on the Pages project before cut-over.
- The login throttle was per process by design; `RATE_LIMIT_STORE=postgres`
  on the web service puts the counts in a shared table so `maxScale: 3` does
  not triple the allowance. `memory` remains the VPS default.

### (g) What stays on the VPS until cut-over

Everything, until the checklist below is complete; and after it, the things
Cloud Run has no equivalent for:

| Stays | Why |
|---|---|
| `temperp-backup.timer` / `scripts/backup-db.sh` | Nightly `pg_dump -Fc` to R2 under `backups/<db>/`, 30 days kept (`scripts/install-backup-timer.sh` installs the timer; `scripts/backup-check.sh` + `.github/workflows/nightly-backup.yml` are the Actions version for the Neon phase). Neon has point-in-time restore (7 days on Launch), but an off-provider dump is still the one copy Google or Neon cannot lose for you. Point the script at Neon's URL and keep it running on the VPS, or on any box. |
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
`API_ORIGIN` and streams the answer back, adding `X-Forwarded-Host`,
`X-Forwarded-For` in the appending form `httpx.RealIP` expects, and
`X-Origin-Secret` when `ORIGIN_SHARED_SECRET` is set (above, (f)). One path the
server owns is **not** forwarded: `/api/v1/cron` answers 404 at the edge. The
key already makes the endpoint safe anywhere (the Go handler 401s without
`X-Cron-Key`, in constant time); refusing it at Pages is one fewer public
door to that lock, and Cloud Scheduler calls the `run.app` URL directly, so
nothing legitimate ever needed it there.
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
   Node version 22 (`NODE_VERSION=22` as a build env var — the same major the
   Dockerfile and the LAN build box use; the lockfile has packages that
   declare node ^22.13).
2. Environment variable `API_ORIGIN` = the Cloud Run web service URL, no
   trailing slash. Set it for Production and Preview. Optionally
   `ORIGIN_SHARED_SECRET` (mark it secret), the same value uploaded by
   `secrets.sh` and uncommented in `service-web.yaml`.
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
   this workload), R2 bucket
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
   SESSION_SECRET=<copied from VPS>
   PASSWORD_PEPPER=<copied from VPS>
   CREDENTIAL_KEY=<copied from VPS>
   PAYMENT_GATEWAY_SECRET=<Razorpay key secret, or copy CREDENTIAL_KEY until wired>
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   CRON_KEY=<openssl rand -hex 32; Cloud Scheduler sends it as X-Cron-Key>
   # optional; also set on the Pages project, then uncomment in service-web.yaml
   ORIGIN_SHARED_SECRET=<openssl rand -hex 32>
   ```

   Then `bash deploy/cloudrun/secrets.sh`. `CRON_KEY` is required: without
   it the endpoint answers 401 to everyone and no reminder is ever sent.
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
7. **First deploy.** `gcloud services enable run.googleapis.com
   cloudbuild.googleapis.com artifactregistry.googleapis.com
   secretmanager.googleapis.com cloudscheduler.googleapis.com` once, then
   `bash deploy/cloudrun/deploy.sh --scheduler --dry-run`, read it, then
   without `--dry-run`. It builds, migrates (`up`, `seed-permissions`) and
   only then replaces the web service, curls `/healthz` on the `run.app`
   URL, creates or updates the Cloud Scheduler job `temperp-cron` (every
   minute, `X-Cron-Key`, 60 s deadline, no retries — the next minute is the
   retry) and fires one tick, printing the counts it answered with. Add
   `--with-worker` only if push notifications are wanted now (see (b)).
8. **Smoke test on the `run.app` URL** with every demo role: sign in, load
   the catalog, open a bus on the live map (tiles from R2), upload a file
   (presign to R2), enqueue something and watch the web service's log
   consume it (`queue workers running in-process` at boot, then the job),
   and confirm in the admin queue screen or `cron_runs` that
   `message_dispatch` has a `last_run` within the last minute.
9. **DNS.** Map `BASE_URL`'s hostname to the web service. Point the VPS
   nginx at a 301 to the new host. Sessions do not survive the hostname
   change (the cookie is host-bound); tell the school to expect one sign-in.
10. **Stop the VPS services** — `systemctl disable --now temperp-web
    temperp-worker` — but leave the box, its database and the nightly backup
    running for two weeks. A stopped worker is what makes the rollback below
    clean: the queue is rows in whichever database the worker points at, and
    a VPS worker still running against the VPS database would keep ticking
    the VPS's cron (`CRON_INPROCESS=1`) and sending yesterday's reminders from
    the old copy.
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
4. Scale Cloud Run down rather than deleting it: `gcloud scheduler jobs
   pause temperp-cron --location asia-south1` stops the minute tick, after
   which the web service costs nothing at zero traffic (and works no jobs —
   the VPS worker is doing that again). If the optional worker was deployed,
   `gcloud run services update temperp-worker --min-instances 0` stops its
   always-on charge. Delete when the second attempt is scheduled.

Rolling back a **single bad deploy** on Cloud Run, as opposed to the whole
move, is the platform's strong suit: `gcloud run services update-traffic
temperp-web --to-revisions PREVIOUS=100` in asia-south1 (same for the worker,
if deployed).
The image tag is the commit hash, so "which revision" has the same answer it
does on the VPS (`make deploy-server COMMIT=…`). Migrations are the exception,
as they are everywhere: `migrate down` exists, but a downgrade after data has
been written under the new schema is a decision, not a command.
