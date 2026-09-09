# Hosting on Cloud Run: the target architecture

This is the plan for moving the ERP off the single VPS
(`187.127.178.100`, see [scripts/deploy.sh](../scripts/deploy.sh)) onto
Google Cloud Run in Mumbai with managed Postgres, and everything the code
demands that the plan did not know about. The manifests and scripts that
implement it live in [deploy/cloudrun/](../deploy/cloudrun/). It was executed
on 2026-09-08; the section directly below records what that run found, and
the checklist and rollback at the end are corrected to what was actually
done. The rest is the reasoning, kept as written.

## What happened on 2026-09-08

The cut-over ran, and the ERP now serves from Cloud Run, Neon and Cloudflare
Pages. The names, so nobody has to look them up again:

| What | Where |
|---|---|
| GCP project | `project-2a0e3e6a-308a-4484-9cb` (number 480232416236), region `asia-south1`, under the Google account infovivencia2026@gmail.com |
| Cloud Run web service | https://temperp-web-480232416236.asia-south1.run.app |
| Cloudflare Pages | project `school-erp`, production https://school-erp-cqj.pages.dev (the bare `school-erp.pages.dev` was already taken) |
| Neon | project `school-erp`, Singapore, Postgres 17, database `school_erp`, roles `erp_owner` and `app_user` |
| R2 | bucket `school-erp` |
| VPS | still up: nginx as the front door for the old hostname, tiles, the assistant, and the rollback copy of the database |

Where the run disagreed with the plan (every one of these cost time, which
is why they are written down):

- **No service-account keys.** The organisation's Secure-by-Default policy
  forbids JSON keys for service accounts, so deploys run as the signed-in
  user (`gcloud auth login`), not as a `deployer` service account. The
  `temperp-run` runtime service account in the manifests is unaffected; it
  is a Cloud Run identity, not a key.
- **`/healthz` from outside is a Google 404.** Cloud Run's edge answers an
  external `GET /healthz` with a Google-branded 404 page on *every* service,
  before the container is asked. The container's own startup and liveness
  probes still reach it, so the manifests keep it and the revision was up
  the whole time; only the external check in `deploy.sh` failed, and the
  script exited before creating the scheduler. The check now asks
  `/api/v1/session` (commit 0592b3f0), which is unauthenticated by design
  and opens a tenant transaction, so a 200 proves both that the revision is
  serving and that it can reach Neon as the app role. Do not spend an hour
  on this again: a 404 on `/healthz` from `curl` means nothing.
- **Nobody could invoke the service.** Cloud Run does not grant public
  invocation by itself, and the Pages Function calls the `run.app` URL with
  no credentials. `deploy.sh` now adds `allUsers` → `roles/run.invoker`
  after every replace (same commit; idempotent).
- **The image put the binary and the bundle at the same path.** The
  Dockerfile copied the Go binary to `/app/web` and then the SPA's `dist`
  to `/app/web` as a directory; Docker refused with "not a directory" and
  Cloud Build never produced an image. The bundle is now `/app/dist` and
  `WEB_DIST` follows it in the Dockerfile and `service-web.yaml` (commit
  851754eb).
- **Pages proxied to the box the move was leaving.** `API_ORIGIN` was a
  dashboard field still naming the VPS, so the new backend sat idle. It now
  lives in [web/wrangler.toml](../web/wrangler.toml) under `[vars]`, which
  Pages honours on every git build and which makes the dashboard copy
  read-only (commit 2029143e). The backend a deployment talks to is a line
  in the repo, not a console setting.
- **A custom domain was attached by mistake.** `serverless.yajur.org` was
  added to the Pages project; the owner does not own `yajur.org`. Remove it
  in the Pages dashboard (Custom domains). Until then it is a dangling
  entry, harmless but wrong.
- **Neon's role names are not the VPS's.** `temperp_owner` / `temperp_app`
  in (d) are what `scripts/deploy.sh` creates on the VPS. On Neon they are
  `erp_owner` (console-created, so a member of `neon_superuser`; used for
  migrations only) and `app_user` (created via SQL, no `bypassrls`; the
  role the app connects as). The app uses the direct endpoint, as (d)
  recommends. `pg_restore` needs `--no-privileges` *because* of this
  renaming; see step 5 of the checklist.
- **Secrets pin at revision creation.** After copying `PASSWORD_PEPPER`,
  `SESSION_SECRET` and `CREDENTIAL_KEY` from the VPS into Secret Manager as
  version 2, the running revision kept using version 1: a revision resolves
  `key: latest` when it is created, not per request. A new revision had to
  be rolled (`gcloud run services update temperp-web --update-env-vars
  DEPLOY_STAMP=<now>`) to pick them up. Any secret change needs a new
  revision.
- **The old hostname stays a front door, not a redirect.** The fingerprint
  reader (`/iclock/`) and the installed phone apps are configured with
  `temperp.187-127-178-100.sslip.io` and cannot be re-pointed remotely, so
  nginx there proxies the API paths to Cloud Run and only the SPA
  catch-all redirects to Pages. (g) and step 9 describe this.
- **Tiles and the assistant did not move.** `/tiles/` (527 MB archive) and
  `/assistant/` (ragbot) stay on the VPS with CORS for the Pages origin, and
  the SPA build reaches them by absolute URL from
  [web/.env.production](../web/.env.production) (`VITE_TILES_BASE`,
  `VITE_ASSISTANT_URL`). Mirroring the tiles to R2 is still open.

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
`cron_runs`; Cloud Scheduler calls it and the worker only works jobs. On the VPS the worker still ticks in-process (`CRON_INPROCESS=1`).

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
ticks cron: Cloud Scheduler calls `/api/v1/cron`, and that request is when the
queue is looked at overnight; during the day the bus-position polls do it. The trade-off, spelled out in the header of
[service-web.yaml](../deploy/cloudrun/service-web.yaml): with
`cpu-throttling: "true"` a job that outlives the request that woke the
instance runs on a throttled CPU until the next request — acceptable for a
queue whose handlers are a few SQL statements and a few gateway calls, with
the tick bounding the stall — and a heavy job shares the instance with
users' requests (the fee fan-out is already chunked). Every instance is also a
worker and opens River's own pool (12 workers + 4), which is why `maxScale` is
3 and `DB_MAX_CONNS` 8: 3 × (8 + 16) = 72 connections at full fan-out, under
Neon's ~100. The limiters are shared through Postgres
(`RATE_LIMIT_STORE=postgres`) so three instances agree on a login throttle.

**The tick is not one job, it is two.** `deploy.sh --scheduler` creates
`temperp-cron` on `* 6-20 * * *` and `temperp-cron-night` on
`*/15 0-5,21-23 * * *`, both `Asia/Kolkata`, both hitting the same URL with the
same header. Through the school day the finest entry in the schedule is every
minute and a receipt or an absence alert should not wait for the next quarter
hour. Overnight nothing is waiting: quiet hours hold every message queued after
the evening cut-off until 09:00 the next morning (`sendAtFor`/`afterQuiet` in
[internal/api/messaging.go](../internal/api/messaging.go)), so a fifteen-minute
night cadence delays nothing a parent sees. It is 36 wake-ups a night instead of
1,440, which is what lets Neon reach its five-minute idle suspend and Cloud Run
stay at zero instances between 21:00 and 06:00 — most of what an overnight bill
is on this plan. An entry whose occurrences pass while the night job sleeps
fires once when the next tick reaches it rather than catching up one call per
missed minute; that collapse is the contract `cron.go` has always had. The
overnight entries survive it: `attendance_rollup` at 00:30 and `session_prune`
at 03:00 land on quarter-hour boundaries the night job hits exactly, and
`transport_position_retention` at 03:20 and the five-minute trip-timeout sweep
are late by at most ten minutes on work nobody is waiting for.

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

*As of 2026-09-08 this has not been done*: `web/.env.production` sets
`VITE_TILES_BASE=https://temperp.187-127-178-100.sslip.io/tiles`, and nginx
on the VPS keeps serving the archive with CORS for the Pages origin. It
works, it is one more thing the VPS must stay up for, and the R2 mirror is
the step that removes it.

### (d) Neon: TLS in the URLs, and the two roles created by hand

`pgxpool.ParseConfig` passes `sslmode` straight through, and Neon refuses
plaintext, so both URLs need it:

```
DATABASE_URL=postgres://app_user:…@ep-….ap-southeast-1.aws.neon.tech/school_erp?sslmode=require
MIGRATE_DATABASE_URL=postgres://erp_owner:…@ep-….ap-southeast-1.aws.neon.tech/school_erp?sslmode=require
```

(Those are the Neon names. The SQL below still says `temperp_owner` /
`temperp_app` because it is the VPS's script with the VPS's names; on Neon
read `erp_owner` for the first and `app_user` for the second, and
`school_erp` for the database. The project is `school-erp` in Singapore, PG
17.)

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
role. That is exactly how it was done: `erp_owner` is console-created (a
`neon_superuser` member, which is acceptable for the role that only runs
migrations) and `app_user` was created from SQL, with no `bypassrls`, so
`FORCE ROW LEVEL SECURITY` binds it. And `ALTER DEFAULT PRIVILEGES FOR ROLE
erp_owner` only applies to objects `erp_owner` creates — so migrations must
run as `erp_owner` (they do: `MIGRATE_DATABASE_URL`), never as the Neon
default role, or new tables come up without the app grants and every query
on them fails with "permission denied".

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
   `files` table pointing at local storage. They needed copying into the
   bucket — and, it turned out, nothing else: the local store lays files out
   under `institution_id/yyyy-mm/uuid.ext`, which is the same key the R2
   path uses, so `aws s3 sync /var/lib/temperp/files s3://school-erp/`
   against the R2 endpoint made every row valid with no rewrite (17 objects
   on 2026-09-08). No migration script was needed.
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
| `temperp-backup-neon.timer` / `scripts/backup-db.sh` | **No longer the only copy** — see (h). It dumps Neon nightly at 19:45 UTC to `neon/backups/school_erp/` from the VPS; `.github/workflows/nightly-backup.yml` now does the same from GitHub Actions at 20:00 UTC to `actions/backups/school_erp/`. Keep both while the VPS lives; when it is switched off, `systemctl disable --now temperp-backup-neon.timer` and nothing else changes. |
| The assistant (`ragbot.service`, `/assistant/`) | Python + Gemini/ollama on the same host; a separate service with its own hosting decision. `VITE_ASSISTANT_URL` in the SPA build points wherever it lands. |
| The `erp.` sibling deployment | Unrelated to this move. |
| DNS for `temperp.187-127-178-100.sslip.io` | sslip.io encodes the VPS IP, so the hostname cannot be re-pointed; and the fingerprint reader and the installed phone apps have it baked in. nginx keeps it alive as a **front door**: `/etc/nginx/snippets/temperp-cloudrun.conf` proxies the server-owned paths (`/api/`, `/login`, `/logout`, `/iclock/`, `/static/`, `/apps`, `/buy`, `/signup`, `/forgot`, `/reset`, `/healthz`) to the Cloud Run URL with `proxy_ssl_server_name on` and `Host` set to the `run.app` host, and the SPA catch-all is a 301 to the Pages URL. |
| nginx | The front door above; the tile server (`/tiles/`, with CORS for the Pages origin) until the archive is on R2; and the CORS-answering proxy for `/assistant/`. |
| The local `temperp` database | Stopped services, live data, as the rollback copy for two weeks after cut-over (the two weeks end 2026-09-22). This is the one remaining thing that would be *lost* by pulling the plug, and it is a rollback convenience, not a backup: the backups are in R2. |

### (h) Backups and uptime, off the VPS

Written 2026-09-09. Two operational things still pointed at the machine this
move is retiring: the only nightly dump ran from a systemd timer on it, and
the uptime check watched its hostname. A backup that dies with the box it is
meant to survive is not a backup, and a monitor watching the wrong address is
worse than none, because it is quiet for the wrong reason.

**Which backups exist, and where each lands.** All three, at once, on purpose:

| Copy | Runs where | When | Lands | Kept |
|---|---|---|---|---|
| Neon point-in-time restore | Neon | continuous | Neon's own storage | 7 days (Launch plan) |
| `temperp-backup-neon.timer` → `scripts/backup-db.sh` | the VPS | 19:45 UTC | R2 `school-erp/neon/backups/school_erp/` | 30 days |
| `.github/workflows/nightly-backup.yml` → `scripts/backup-check.sh` | GitHub Actions | 20:00 UTC (01:30 IST) | R2 `school-erp/actions/backups/school_erp/` | 30 days |

The two prefixes are deliberately different so that it is obvious which copy
came from where, and so neither one's retention pass can prune the other's.
The Actions copy is the one that outlives the VPS. Neon's PITR is the fastest
recovery for "an hour ago", but it lives inside the provider; the R2 dumps are
the copy neither Google nor Neon can lose for you.

**How the Actions backup proves itself**, rather than trusting the exit code
of `pg_dump`: it compares `pg_dump --version` against `SHOW server_version`
and refuses *before* spending the dump (Neon is PostgreSQL 17 and the Ubuntu
runner ships older — the workflow installs `postgresql-client-17` from PGDG
for exactly this reason, and the check stays because the install can silently
be the wrong one); it writes to a `.part` name and renames only on success;
it refuses a dump under 1 KiB; it reads the archive back with
`pg_restore --list` and refuses if that names no tables; it uploads, lists the
object back and compares its byte count with the local file; and only after
all of that does it prune anything older than 30 days, so a bad night never
deletes the good nights before it. If the optional `RESTORE_URL` secret names
a scratch Neon branch, it also restores the dump there and fails unless the
restored table count matches the dump's. A failed scheduled run opens a
`backup-failed` issue and a later good run closes it.

**Which secrets exist, and where.** Repository secrets (Settings → Secrets and
variables → Actions). None of these values is in the repo; they live in
`deploy/cloudrun/.env.cloudrun` (gitignored, on the operator's machine) and on
the VPS in `/etc/temperp-backup-neon.env`.

| Secret | Value | Where the value comes from |
|---|---|---|
| `DATABASE_URL` | Neon **owner** URL, direct (non-pooler) endpoint, database `school_erp` | `MIGRATE_DATABASE_URL` in `.env.cloudrun`, or `BACKUP_DATABASE_URL` on the VPS. The owner is needed because every tenant table has `FORCE ROW LEVEL SECURITY` and the app role cannot dump past it; the owner has `BYPASSRLS` through `neon_superuser`. |
| `R2_BUCKET` | `school-erp` | either file |
| `R2_ACCOUNT_ID` | Cloudflare account id | either file (or set `R2_ENDPOINT` instead) |
| `R2_ACCESS_KEY_ID` | R2 API token id, Object Read & Write on that bucket | either file, or mint a separate token in the Cloudflare dashboard so it can be revoked without touching the app |
| `R2_SECRET_ACCESS_KEY` | its secret | as above |
| `RESTORE_URL` | *optional.* Owner URL of a scratch **Neon branch** | Neon console → Branches → new branch from main. Its `schema public` is **dropped on every run**, so it must not be production and must not be anything that is read. |

`R2_PREFIX` is not a secret and is set in plain sight in the workflow, so that
the file itself says which prefix this copy writes to.

**Restoring from one of these dumps.** The dumps are `pg_dump -Fc`, so
`pg_restore` can pull a single table out of one, which is what is actually
wanted at eight in the morning when one table was truncated. Fetch the object
(`aws s3 cp s3://school-erp/actions/backups/school_erp/<stamp>.dump . \
--endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`), then follow
the same procedure as step 5 of the checklist above — it is still accurate and
it is still the one that works: `DROP SCHEMA public CASCADE; CREATE SCHEMA
public AUTHORIZATION erp_owner;`, then `pg_restore --no-owner --no-privileges
--role=erp_owner --exit-on-error`, then re-`GRANT` to `app_user`. The two
flags are not optional and neither is the re-grant: the dump's `GRANT`
statements name roles that do not exist on Neon, and without the re-grant
afterwards the app role can see no table. Note the difference from the
*readability* check inside `backup-db.sh --restore-check`, which uses the same
two flags but deliberately does not re-grant: it is asking "can this file be
read back", not "is the app running again".

**What the uptime check watches.** `.github/workflows/uptime.yml`, every ten
minutes, probes **both** ends and calls the site down if either is:

- `https://school-erp-cqj.pages.dev` — what a parent opens, exercising Pages,
  the Pages Function proxy, Cloud Run and Neon in one request.
- `https://temperp-web-480232416236.asia-south1.run.app` — Cloud Run directly,
  bypassing Cloudflare.

They fail independently, and the case that needs both is the Pages proxy
failing while Cloud Run is healthy: a total outage for every user, invisible
to a probe that only asks the backend. The issue body names which of the two
answered badly, which is most of the diagnosis.

The path probed is **`/api/v1/session`, not `/healthz`**. From outside, Cloud
Run's edge answers `GET /healthz` with a Google-branded 404 on every service
(see "what actually went wrong" above), so `/healthz` reports a healthy
deployment as down. `/api/v1/session` is unauthenticated by design — it is
what the SPA asks on load — and its handler opens a tenant transaction, so a
200 there proves the Go process *and* the database, which `/healthz` never
did. `/healthz` remains correct as Cloud Run's own container startup probe.

The parent-APK check is no longer part of the scheduled probe: `APK_DIR` is
unset on Cloud Run and `/apps` is served by the VPS nginx, so asking
production for it would report a permanent false alarm. `bash
scripts/uptime-check.sh <url> --apk` still does it by hand.

**What is still tied to the VPS after this change**, in the order it matters:

1. **The map tiles.** `/tiles/` is the 527 MB PMTiles archive plus fonts and
   sprites, served by nginx with CORS for the Pages origin, and
   `web/.env.production` still points `VITE_TILES_BASE` at the VPS hostname.
   The bus map goes blank the day that box is switched off. Mirroring it to
   R2 with `scripts/refresh-tiles.sh` (`TILES_R2=1`) and rebuilding the SPA
   against the R2 public host is the open item.
2. **The local rollback database.** Live data as of cut-over, kept until
   2026-09-22. It is the only thing here that would be *lost* by pulling the
   plug rather than merely stopped.
3. **The `sslip.io` front door.** The hostname encodes the VPS IP, so it
   cannot be re-pointed, and the fingerprint reader and the installed phone
   apps have it baked in. nginx proxies the server-owned paths to Cloud Run.
   Retiring the box means re-provisioning the reader and reinstalling the
   apps, which is why it is last.
4. **The assistant** (`ragbot.service`, `/assistant/`) and the **parent APK**
   download, both of which are separate hosting decisions.
5. The VPS's own `temperp-backup-neon.timer` — now a second copy rather than
   the only one, which is the point of this change.


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
2. `API_ORIGIN` = the Cloud Run web service URL, no trailing slash. It is
   **not** a dashboard variable: it lives in `[vars]` in
   [web/wrangler.toml](../web/wrangler.toml), which Pages reads on every git
   build and which makes the dashboard's copy read-only. Optionally
   `ORIGIN_SHARED_SECRET` (a dashboard secret, since it must not be in the
   repo), the same value uploaded by `secrets.sh` and uncommented in
   `service-web.yaml`.
3. Custom domain (e.g. `app.<school>.in`) on the Pages project; the DNS is a
   CNAME Cloudflare adds itself when the zone is on Cloudflare. Only a
   domain the owner controls: `serverless.yajur.org` was attached on
   2026-09-08 and must be removed.
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

In order, as it was actually run on 2026-09-08. Each step is reversible
until step 9.

1. **Code prerequisites** (Go/TS changes, out of scope for the manifests).
   Done alongside the Dockerfile: `cmd/web` serves the SPA from `WEB_DIST`
   and `internal/config` falls back to `PORT`; the worker listens on `$PORT`
   with `/healthz`; `RealIP` takes the last hop. `TILES_BASE` reads
   `VITE_TILES_BASE`, so the R2 public host is a build-time variable, not a
   code change. Merge to `main`.
2. **Accounts.** GCP project with billing (`project-2a0e3e6a-308a-4484-9cb`,
   asia-south1), Neon project `school-erp` in `ap-southeast-1` (Singapore;
   Neon has no Mumbai region — ~40 ms from asia-south1, fine for this
   workload), R2 bucket `school-erp` with CORS and a public custom domain.
   `gcloud auth login` as the project owner; the org policy forbids
   service-account keys, so there is no `deployer` identity to create.
3. **Neon roles and grants.** Create `erp_owner` in the console and
   `app_user` from SQL, then run the grants in (d) with the names swapped.
   Create the `school_erp` database owned by `erp_owner`.
4. **Secrets.** Copy `PASSWORD_PEPPER`, `SESSION_SECRET`, `CREDENTIAL_KEY`
   from the VPS's `/etc/temperp.env` — they must not change, the pepper
   above all — into `deploy/cloudrun/.env.cloudrun` (gitignored) along with
   the new URLs and the R2 keys. Template:

   ```
   PROJECT_ID=project-2a0e3e6a-308a-4484-9cb
   BASE_URL=https://school-erp-cqj.pages.dev
   R2_ACCOUNT_ID=…
   R2_BUCKET=school-erp
   R2_PUBLIC_HOST=files.myschool.in
   DATABASE_URL=postgres://app_user:…@…neon.tech/school_erp?sslmode=require
   MIGRATE_DATABASE_URL=postgres://erp_owner:…@…neon.tech/school_erp?sslmode=require
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
   If a secret is added or changed *after* a revision exists, roll a new
   revision (`gcloud run services update temperp-web --region asia-south1
   --update-env-vars DEPLOY_STAMP=$(date +%s)`): a revision pins secret
   versions when it is created, even with `key: latest`. This bit on
   2026-09-08 when the three VPS values went in as version 2.
5. **Data.** The procedure that worked, in full:

   ```
   # On the VPS, as postgres, into /tmp (postgres cannot write /root):
   sudo -u postgres pg_dump -Fc temperp -f /tmp/temperp.dump

   # On Neon, as erp_owner, on school_erp:
   DROP SCHEMA public CASCADE;
   CREATE SCHEMA public AUTHORIZATION erp_owner;
   GRANT USAGE ON SCHEMA public TO app_user;
   REVOKE CREATE ON SCHEMA public FROM app_user;

   pg_restore --no-owner --no-privileges --role=erp_owner --exit-on-error \
       -d "$MIGRATE_DATABASE_URL" /tmp/temperp.dump

   # Then, as erp_owner:
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
   ```

   `--no-privileges` is **required**, not optional: the dump's `GRANT`
   statements name `temperp_app`, which does not exist on Neon, and
   `--exit-on-error` would stop on the first one. That is also why the
   re-grant afterwards is not optional — without it the app role can see
   no table. Verify the grants came back with
   `SELECT count(*) FROM information_schema.role_table_grants WHERE
   grantee='app_user'` (1832 on 2026-09-08), then the shape: 457 tables,
   434 with `relforcerowsecurity`, 434 policies, goose at 302. A local
   `pg_restore` 18 restored a `pg_dump` 16 archive into PG 17 without
   complaint. The goose version table comes across with the dump, so
   `migrate up` afterwards is a no-op unless the image is newer than the
   VPS.
6. **Files.** `aws s3 sync /var/lib/temperp/files s3://school-erp/
   --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. No
   row rewrite: the local paths are already the R2 keys ((e) above). The
   tiles archive was **not** moved; `web/.env.production` points the map
   at the VPS's `/tiles/` until it is.
7. **First deploy.** `gcloud services enable run.googleapis.com
   cloudbuild.googleapis.com artifactregistry.googleapis.com
   secretmanager.googleapis.com cloudscheduler.googleapis.com` once, then
   `bash deploy/cloudrun/deploy.sh --scheduler --dry-run`, read it, then
   without `--dry-run`. It builds, migrates (`up`, `seed-permissions`) and
   only then replaces the web service, grants `allUsers` the invoker role,
   curls `/api/v1/session` on the `run.app` URL (not `/healthz` — see the
   top of this document), creates or updates the Cloud Scheduler job
   `temperp-cron` (every minute, `X-Cron-Key`, 60 s deadline, no retries —
   the next minute is the retry) and fires one tick, printing the counts
   it answered with. Add `--with-worker` only if push notifications are
   wanted now (see (b)).
8. **Smoke test on the Pages URL** with every demo role: sign in, load the
   catalog, open a bus on the live map (tiles from the VPS for now), upload
   a file (presign to R2), enqueue something and watch the web service's
   log consume it (`queue workers running in-process` at boot, then the
   job), and confirm in the admin queue screen or `cron_runs` that
   `message_dispatch` has a `last_run` within the last minute. Check that
   `API_ORIGIN` in `web/wrangler.toml` is the `run.app` URL and that the
   Pages build that is live was built after that commit.
9. **The old hostname.** Not a plain 301. Back up the site file
   (`/root/nginx-temperp.before-cloudrun.bak`), then install
   `/etc/nginx/snippets/temperp-cloudrun.conf`: the server-owned paths
   (`/api/`, `/login`, `/logout`, `/iclock/`, `/static/`, `/apps`, `/buy`,
   `/signup`, `/forgot`, `/reset`, `/healthz`) `proxy_pass` to the Cloud
   Run URL with `proxy_ssl_server_name on` and `proxy_set_header Host` the
   `run.app` host; `/tiles/` and `/assistant/` stay local with
   `Access-Control-Allow-Origin` for the Pages origin; the SPA catch-all
   becomes a 301 to the Pages URL. The fingerprint reader and the phone
   apps keep talking to the hostname they were given and land on Cloud
   Run. Browser sessions do not survive the hostname change (the cookie is
   host-bound); tell the school to expect one sign-in.
10. **Stop the VPS services** — `systemctl disable --now temperp-web
    temperp-worker` — but leave the box, its database and the nightly backup
    running for two weeks. A stopped worker is what makes the rollback below
    clean: the queue is rows in whichever database the worker points at, and
    a VPS worker still running against the VPS database would keep ticking
    the VPS's cron (`CRON_INPROCESS=1`) and sending yesterday's reminders from
    the old copy. Done 2026-09-08; the two weeks end 2026-09-22.
11. **After two weeks:** decommission the VPS database. `backup-db.sh` was
    repointed at Neon already (`temperp-backup-neon.timer`), and since
    2026-09-09 GitHub Actions runs the same dump independently of the box —
    see (h) — so nothing has to happen to the backups first.

## Rollback

Within the two-week overlap, rollback is two commands on the VPS plus a
decision about data, because nothing there was removed:

1. `systemctl enable --now temperp-web temperp-worker` on the VPS.
2. Restore the nginx site file from
   `/root/nginx-temperp.before-cloudrun.bak` and `nginx -t && systemctl
   reload nginx`. That drops the Cloud Run proxy and the 301, and
   `temperp.187-127-178-100.sslip.io` serves the VPS build again; the
   reader and the apps never noticed either way. No DNS is involved —
   sslip.io never changed.
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
