# Agent contract — read this first, every time

## 0. Base check (MANDATORY, before any other command)

    git log --oneline -1
    git log --oneline -1 origin/operational-erp

**Do NOT `git reset --hard origin/operational-erp` on reflex.** On three
occasions in a single day `origin` was *behind* the local branch, and a worker
obeying an earlier version of this instruction would have destroyed a commit it
had been told to build on. Three workers caught it independently. That is luck,
not a process.

What to do instead:

1. The coordinator names your base commit in your brief. That SHA is the truth.
2. If `git log --oneline -1` already shows it, you are on the right base. Stop.
3. If it does not, `git fetch origin`, then **`git reset --hard <that SHA>`** —
   the explicit commit, never a branch name. Verify with `git log --oneline -1`
   before touching anything.
4. If the SHA does not exist after fetching, stop and report. Do not guess a
   nearby commit.

Every worker so far has found their worktree branched from an old commit, so
assume yours is wrong until you have checked. If you have uncommitted work,
**never reset at all** — you would lose it; finish where you are and say so.

## 1. Files you must NEVER edit (contention points)

- `internal/api/api.go`      — deliver `func (s *Server) mount<Domain>(r chi.Router)` in your own file
- `web/src/features/registry.ts` — deliver `web/src/features/<area>/<domain>-keys.ts` exporting a const object
- any migration you did not create

The integrator splices these in. If you edit them your work will conflict and be rejected.

## 2. Catalogue keys are given to you. Never invent one.

Your prompt lists the exact keys. Verify each with:

    grep -n '"<key>"' internal/catalog/catalog_gen.go

If a key is not in that file, it does not exist — report it, do not guess a variant.

## 3. Search before you create

Before adding ANY table, type, or handler:

    grep -rn '<concept>' migrations/ internal/ | head -30

Two agents independently creating `alumni_profiles` cost a day of reconciliation.
Reuse existing tables. Extend with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

Check for Go symbol collisions in package `api` before naming anything:

    grep -rn 'type <Name> \|func <name>(' internal/api/

## 4. Migrations

- Claim the number given in your prompt. Note in a comment that it may be renumbered at integration.
- Every new table needs, in this order: `CREATE TABLE`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, a policy using `app_current_institution()`
  and `app_is_platform_admin()`, then `GRANT SELECT, INSERT, UPDATE, DELETE ... TO app_user`.
  Copy the shape from `migrations/00044_messaging.sql`.
- **The nullable-UNIQUE trap.** A NULL is distinct from every other NULL, so a UNIQUE index
  containing a nullable column silently enforces nothing. This codebase has been bitten six
  times. Always: `COALESCE(col, '00000000-0000-0000-0000-000000000000'::uuid)`.
- Write a real `-- +goose Down`.
- Do not use `in_at::date` or any non-IMMUTABLE expression in an index. Add a stored column.

## 5. Money, dates, tenancy

- Money is `bigint` **paise**. Never float. Indian digit grouping in the UI.
- Financial year is April–March — use `currentFY()`. "Now" is `nowInIndia()` in `daterange.go`.
- All queries run through `db.InTenant` (or `db.AsPlatform` for platform scope).
- Authorization is decided on the backend. Call `resolveScope` and honour it —
  a UI that hides a button is not access control.

## 6. RBAC

Reuse existing permissions from `internal/rbac/model.go`. Do not invent a permission that
duplicates one that exists. Grep first.

## 7. Build & test — memory limits

This machine has ~1.7 GB free. You will be killed if you exceed it.

- ALLOWED: `go build ./...`, `go test ./...`, `npx tsc --noEmit`
- **FORBIDDEN**: `npm run build`, `vite build`, `vite dev`, any bundler. Never.
- Run one build at a time. Do not background builds.

## 8. Definition of done

    [ ] go build ./... clean
    [ ] go test ./... clean
    [ ] npx tsc --noEmit clean
    [ ] migration applies AND rolls back (goose up / goose down / goose up)
    [ ] every catalogue key you were given resolves to a real screen
    [ ] no edits to api.go / registry.ts / others' migrations
    [ ] authorization verified — a user without the permission gets 403, not data

## 9. Report format (your final message)

    STATUS: DONE | PARTIAL | BLOCKED
    FEATURES: <key> = built | blocked:<reason>   (one line each)
    MOUNT: <function name and file>
    KEYS: <keys file path and exported const name>
    MIGRATION: <file>
    TABLES: <new tables>
    CHECKS: build=ok test=ok tsc=ok goosedown=ok
    NOTES: <anything the integrator must know — collisions, renames, assumptions>

Return data, not prose. Do not commit to a shared branch — leave your work in your worktree.
