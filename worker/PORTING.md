# Porting a Go API domain to the Worker

Read this whole file before writing a line. Every agent porting a domain
follows it; the shared files are frozen while ports run.

## Where things are
- Go source of truth: `internal/api/api.go` (route table, chi) and the handler
  files it names. `internal/rbac/` has the permission keys.
- Worker: `worker/src`. Shared, DO NOT EDIT: `index.ts`, `router.ts`,
  `identity.ts`, `http.ts`, `env.ts`, `tenant.ts`, `auth/*`, `routes/index.ts`,
  `routes/session.ts`, `routes/login.ts`. If you need something added to a
  shared file, write it in your own file instead and note it in your report.
- Schema: `worker/db/tenant.sql` (one database per school) and
  `worker/db/control.sql` (platform). Read the tables you touch; column names
  came from Postgres unchanged, types did not (see below).

## Your deliverable
One file `worker/src/routes/<domain>.ts` exporting
`export function register<Domain>(r: Router): void` that registers every
route of your block with `r.get/post/put/patch/del(pattern, perm, handler)`.
`perm` is the rbac key string the Go route used (`rbac.StudentsRead` ->
`'students.read'`; read `internal/rbac` for the value), or `'auth'` when the
Go route had no RequirePermission. Patterns use `{id}` like chi.
Helper code your routes share goes in the same file or in
`worker/src/routes/<domain>/*.ts`. Nothing else.

Handlers receive `Ctx` (`router.ts`): `c.db` is the school's D1 database,
`c.id` the caller, `c.params`, `c.url.searchParams`, `c.req`. Use the helpers in
`http.ts` (readJSON, ok, created, notFound, badRequest, clampInt, uuidParam,
page, like, now, uuid, bool). Errors: `throw notFound('...')` etc.

## Rules that are not optional
1. Same URL, method, query params, request body and response JSON as the Go
   handler, field for field, so `web/src` needs no change. Read the Go
   response structs and copy the json tags.
2. SQLite dialect. No `::casts`, no `= ANY($1)`, no `NOW()`, no `RETURNING`
   into multiple rows, no `ON CONFLICT ... WHERE`, no arrays, no `ILIKE`
   (use `LIKE` with the `like()` helper; text columns that were citext are
   `COLLATE NOCASE` already). Placeholders are `?`. jsonb columns are TEXT
   holding JSON: use `json_extract`, `json_each`, `json_set`.
3. Types: uuids are TEXT (`uuid()` makes one), timestamps TEXT ISO-8601 UTC
   (`now()`), booleans INTEGER 0/1 (return them to the client as true/false
   with `bool()`), numeric/money TEXT (do arithmetic in JS with care, return as
   the Go struct did: number or string, check the tag).
4. No RLS. The database boundary is the tenant. Still fill `institution_id`
   on every INSERT from `c.id.institution!.id`, because the columns are NOT
   NULL and other code reads them.
5. Triggers and plpgsql are gone. If a Go handler relied on a trigger (search
   `migrations/*.sql` for `CREATE TRIGGER` on the tables you write to), do
   what the trigger did in the handler, in a `c.db.batch([...])` so it is
   atomic. Say which triggers you re-implemented in your report.
6. Multi-statement writes go through `c.db.batch([...])`. There are no
   interactive transactions on D1.
7. Side effects that leave the database (email, SMS, WhatsApp, push, R2
   files, PDF rendering, Tally, payment gateways): do not implement. Call a
   stub `notImplemented('<what>')` that throws HttpError 501 with that
   message, defined in your own file, and list every stub in your report.
8. Scope narrowing (`resolveScope` in api.go: HODs, class teachers, parents
   see only their own) must be ported where the Go handler applied it; read
   `internal/scope` for the rules.
9. `npx tsc --noEmit` in `worker/` must pass with your file added. Add your
   register call to `routes/index.ts` is NOT yours to do; instead put the
   exact import and call lines at the top of your report.
10. Do not run `wrangler dev`, do not touch git, do not edit files outside
    the paths named above.

## Report format (your final message)
- Import + register lines for routes/index.ts
- Routes ported (method path) and routes skipped with the reason
- Triggers re-implemented
- Stubs (501) left
- Anything in the Go handler you could not translate faithfully
