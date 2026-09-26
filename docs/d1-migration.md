# Moving the database to Cloudflare D1

Decision (2026-09-26): the data moves to D1 first; the application follows
later. Until the Go backend is ported, production stays on Neon Postgres and
D1 is a copy. Nothing in this directory writes to Postgres.

## Run it

```
npx wrangler@4 login            # once per machine, opens the browser
scripts/d1/migrate.sh export    # reads Neon via deploy/cloudrun/.env.cloudrun
scripts/d1/migrate.sh local     # loads into wrangler's local D1, prints counts
scripts/d1/migrate.sh remote    # creates D1 "school-erp" and loads it
```

`export` writes `scripts/d1/out/` (gitignored): `schema.sql`, `data.sql`,
`school_erp.db` and `report.md`. The report is the contract. It lists every
table's row count, confirms counts match Postgres, and enumerates what did
not cross.

## What the converter does

[scripts/d1/pg_to_d1.py](../scripts/d1/pg_to_d1.py) introspects the live
database (not `db/schema.sql`) and emits SQLite DDL: tables, primary keys,
unique constraints, every foreign key, and plain btree indexes. Rows are
exported with psql and rendered as one INSERT each.

| Postgres | SQLite/D1 |
|---|---|
| uuid, text, citext, enum, inet, bit, date, time | TEXT (citext gets COLLATE NOCASE) |
| timestamptz | TEXT, UTC ISO-8601 with `Z` |
| int2/int4/int8, boolean | INTEGER (booleans 0/1) |
| numeric | TEXT, so money keeps every digit |
| jsonb, arrays | TEXT holding JSON |
| bytea | BLOB |
| generated columns | plain columns, value frozen at export |

Foreign key cycles are handled by loading the nullable back-edge column as
NULL and filling it with an UPDATE after every table is in. On the current
schema that touches two columns (`users.signature_file_id`,
`sms_gateway_devices.pair_code_id`).

## What does not cross, and what the app port must replace

- **Row-level security (about 500 policies).** Tenant isolation today is
  `set_config('app.institution_id', ...)` per transaction in
  `internal/database/resolver.go`. D1 has no RLS; every query in the ported
  backend must carry `WHERE institution_id = ?` itself.
- **Triggers and plpgsql (78 triggers, 39 functions)**, including payment
  allocation and fee engine logic. These become application code.
- **Check constraints (about 1,200)** are in Postgres expression syntax and
  are not translated. Validation moves to the application.
- **Column defaults** such as `gen_random_uuid()` and `now()` (about 1,000).
  The app must supply ids and timestamps on insert.
- **Five indexes.** Partial and expression indexes are translated (332 of
  337 carry over, including every "one live row" uniqueness rule). The five
  that do not are two GIN indexes and three that call Postgres-only
  functions: `users_pin_phone_unique` (regexp_replace),
  `vehicles_registration_normalised` (regexp_replace) and
  `class_diary_entries_no_duplicates` (md5). The Worker must enforce the
  first and third in its handlers.
- **River job queue and LISTEN/NOTIFY.** Replace with Cloudflare Queues and
  Durable Objects, or a polling table.
- **The one view** (`marks_over_paper_maximum`) is easy to recreate by hand.

## Limits to keep in mind

D1 caps a database at 10 GB and a single query result at about 1 MB. The
export report prints the local SQLite size so this is checked every run.
Interactive transactions do not exist on D1; only atomic batches.

## Switchover

The move from Cloud Run + Neon to the Worker + D1 is one script the owner
runs from the repo root, at a quiet hour:

```
WORKER_URL=https://school-erp.<account>.workers.dev bash worker/scripts/switchover.sh
```

It stops and asks (`y` to go on) between every step, and can be re-run from
the top: each run loads into new databases stamped with the time. The load
logic is shared with `load-production.sh` through `worker/scripts/lib-load.sh`.
Optional: `LIVE_HOST` (default `https://school-erp.pages.dev`), `LOCAL_PG`
(local Postgres, default `postgresql://localhost/postgres`), `WORK` (dump and
exports, default `~/erp-switchover-<stamp>`), `USES_PUSH=1` (require
`FCM_SERVICE_ACCOUNT`).

| Step | What happens |
|---|---|
| a. Pre-checks | Tools on PATH, `wrangler whoami`, `$WORKER_URL/healthz` is `ok`, Worker secrets `PASSWORD_PEPPER`, `CREDENTIAL_KEY`, `SESSION_SECRET` (and `FCM_SERVICE_ACCOUNT` with `USES_PUSH=1`), `.env.cloudrun` present, local Postgres reachable, free disk, no uncommitted edits to the two wrangler files. |
| b. Write freeze | The Go server has no maintenance or read-only mode, so the owner announces a pause to both schools and confirms. The hard alternative (Neon `default_transaction_read_only`, which also breaks sign-in on the old site) is printed but not run. |
| c. Snapshot and load | `pg_dump --format=custom` of Neon (`MIGRATE_DATABASE_URL`, read-only), restored into a local database `erp_snapshot_<stamp>`. Schools come from the snapshot's `institutions` table, platform accounts from `users` with no school. Each school is exported with `pg_to_d1.py`, then loaded exactly as `load-production.sh` does: new `school-erp-<slug>-<stamp>` database, `TENANT_<SLUG>` binding moved to it, schema, platform stand-in rows, `split_big.py`, data, and the school/plans/subscription/sign-ins into CONTROL. Platform accounts go into CONTROL from the snapshot. |
| d. Verify | For every school, every table's `count(*)` on D1 (`wrangler d1 execute --json`) must equal the export's (users plus the stand-in rows). Any difference stops the script; the live site is still untouched. |
| e. Files | `FILES_WRITE` in `worker/wrangler.jsonc` becomes the live bucket `school-erp`. Test uploads in `school-erp-d1-uploads` are copied (rclone, never overwriting) only if the owner says yes. Then `wrangler deploy`, a health check, and a commit of `wrangler.jsonc`. |
| f. Live site | `API_ORIGIN` in `web/wrangler.toml` becomes `$WORKER_URL`; the diff is shown and committed on confirmation. Pushing (which makes Pages rebuild and switches every user) is a separate confirmation; say no to push by hand. |
| g. Post-checks | Through the live Pages host: `/healthz`, `/api/v1/session` (200/401), the app shell and sign-in page, and a few read endpoints (200/401/403 means the Worker answered). Then a real sign-in at each school before lifting the pause. |
| h. Rollback | Revert the API_ORIGIN commit and push. Neon was only read and stays the source of truth until the owner decides; keep Cloud Run and Neon up for a week. Anything written on D1 after the switch is not copied back and is lost to the old site on rollback. |
