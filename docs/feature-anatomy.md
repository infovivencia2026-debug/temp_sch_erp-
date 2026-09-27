# Features: anatomy, adding, updating, retiring

(This file is `docs/feature-anatomy.md`, not `docs/features.md`: on macOS the
file system ignores case, and `docs/FEATURES.md` is the generated feature list
from `make docs`. A `features.md` would overwrite it.)

A "feature" is one catalogue entry: a screen a role sees in its menu, the API
behind it, the permissions that gate the API, and the switches that can turn
it off for a school. Today that is spread over a dozen files in three
languages. `scripts/feature.mjs` does the bookkeeping:

```
npm run feature:new    -- --roles faculty,hod --section "Library" --name "Shelf audit" \
                          --summary "What the user sees and does." --module ops \
                          --read operations.library.read --write operations.library.write [--table y]
npm run feature:rename -- --id library.shelf_audit --to "Stock take" [--keep-key]
npm run feature:remove -- --id library.shelf_audit [--drop-tables] [--dry-run]
npm run feature:check  [-- --verbose | --update-baseline]
```

Run from the repository root with Node 22 (`export PATH=~/tools/node22/bin:$PATH`).
`feature:new` prompts for anything missing when run in a terminal. Every
command prints a checklist (`[done]`, `[skip]`, `[todo]`) and is safe to re-run.
Regenerating needs `python3`; Go (`go`, `gofmt`) is used when installed,
otherwise the checklist says what to run on a machine that has it.

## Identity of a feature

| Name | Example | Where it comes from |
|---|---|---|
| Catalogue key | `librarian.library.shelf_audit` | `role.section_slug.feature_slug`, slugs from the CSV's Section and Feature columns (`slug()` in `scripts/gen_catalog.py`) |
| Feature id | `library.shelf_audit` | `section_slug.feature_slug`: the same feature across roles. Used by seller feature switches and by `feature.mjs` |
| Permission keys | `operations.library.read` | Capabilities the API checks. Several features share one |

A catalogue key is also a permission: every school's `permissions` table holds
all of them and the built-in roles are granted theirs (that is what draws the
menu). Renaming a feature therefore renames grants.

## Anatomy of a feature

**Source of truth.** The catalogue is `docs/edu_features.csv`. Permissions and
role grants are Go, `internal/rbac/`, because the Go server is still built in CI
(`.github/workflows/ci.yml`) and still serves production until the switchover
(docs/cloudflare-stack.md). The Worker holds copies; `feature.mjs` edits Go and
the copies together, and `feature:check` fails when they disagree.

G = generated, never edit by hand. S = source, edit (or let `feature.mjs` edit).

| # | File | Holds | |
|---|---|---|---|
| 1 | `docs/edu_features.csv` | The catalogue: Role, Workspace, Section, Feature, summary, Data Scope, Priority, Tier. One row per role that sees the feature | S |
| 2 | `scripts/gen_catalog.py` | Role display name → key (`ROLE_KEYS`), scope wording → scope, `FEATURE_SLUG_OVERRIDE` (rename a label, keep the key) | S |
| 3 | `internal/catalog/catalog_gen.go` | Go catalogue (from 1) | G `gen_catalog.py` |
| 4 | `web/src/catalog.gen.ts` | Web catalogue: navigation tree (from 1) | G `gen_catalog.py` |
| 5 | `web/src/features/registry.ts` + `web/src/features/**/*-keys.ts` | Catalogue key → lazy screen. The only record of "what is built" | S |
| 6 | `web/src/features/<module>/<Screen>.tsx` | The screen | S |
| 7 | `internal/api/implemented_gen.go` | Keys with a screen (from 5) | G `gen_implemented.py` |
| 8 | `internal/api/help_answers_gen.go` | The assistant's precomputed answers (from 1) | G `gen_answers.py` |
| 9 | `internal/rbac/rbac.go` | Permission consts, `All` (the vocabulary), `SystemRoles` (grants per built-in role; `institution_admin` = every key but platform ones) | S, **truth** |
| 10 | `internal/rbac/model.go` | `Groups`: the roles-grid rows. Every permission must be in exactly one (`TestGroupsCoverEveryPermission`) | S, **truth** |
| 11 | `worker/src/services/provision_seed.ts` | Permissions + default role grants a new school's D1 is seeded with (from 1, 9) | G `go run ./scripts/d1/tenant_seed` |
| 12 | `worker/src/routes/admin/static_data.ts` | `CATALOG_ROLES`, `IMPLEMENTED_FEATURES` (G, from 4 and 7 by `feature.mjs sync`); `PERMISSIONS`, `SYSTEM_ROLES`, `GROUPS` (copies of 9, 10: one JSON line each, edited by `feature.mjs`) | G / copy |
| 13 | `worker/src/routes/setup/common.ts` `SYSTEM_ROLES` | The grants the Worker restores a built-in role to (copy of 9, hand-written TS) | copy |
| 14 | `worker/src/routes/<domain>.ts`, `worker/src/routes/<domain>/*.ts` | Route handlers, `r.get/post/.../typed(pattern, perm, handler)`. Rules: `worker/PORTING.md` | S |
| 15 | `worker/src/routes/index.ts` | `buildRouter()`: every domain's `register*` in order | S |
| 16 | `shared/api/<domain>.ts`, `shared/api/index.ts` | Request/response types both sides compile against (`r.typed` / `api.call`) | S |
| 17 | `worker/src/routes/misc/shell.ts` `SECTION_MODULE` | Section slug → plan module (students, fees, library, ...). A section not listed is `core`, always on | S |
| 18 | `worker/src/routes/seller/features.ts` `FEATURE_ROUTES` | Feature id → API prefixes refused while a school has the feature switched off (seller per-school switches). Unlisted features are only hidden from the menu | S |
| 19 | CONTROL `plans.modules`, `school_feature_overrides` | Which modules a plan includes; per-school on/off + rollout end date (data, set in the seller console) | data |
| 20 | `worker/migrations/tenant/NNNN_*.sql` (`node worker/scripts/migrate.mjs new tenant <name>`) | Schema and grant changes for every existing school database. Forward-only | S |
| 21 | `worker/db/tenant.sql` | Per-school schema snapshot (from Postgres, `scripts/d1/pg_to_d1.py`; the migration runner's `schema:sync`) | G |
| 22 | `worker/test/integration/*.test.ts`, `web/src/**/*.test.ts(x)` | Tests. `web/src/features/catalog-keys.test.ts` and `reachable.test.ts` freeze the known dead keys and unreachable screens | S |
| 23 | `docs/features-planned.txt` | Catalogue keys deliberately without a screen | S |
| 24 | `scripts/feature-manifest.json` | What `feature:new` added per feature, so `feature:remove` can take exactly that out (absent when empty) | G `feature.mjs` |
| 25 | `scripts/feature-check-baseline.json` | Known inconsistencies `feature:check` tolerates | G `feature:check --update-baseline` |

`make catalog` regenerates 3, 4, 7, 8 (and runs gofmt). `node scripts/feature.mjs sync`
does that plus 11 and the generated half of 12.

Not touched by the generator: Go API handlers (`internal/api`). A generated
feature is Worker-only until the switchover.

## What `feature:new` does

1. Appends one CSV row per role (workspace and section name reuse the role's
   existing section if there is one) and regenerates 3, 4, 7, 8, 11, 12.
2. Permissions: an existing key is only granted; a new key gets a Go const, an
   `rbac.All` entry, a roles-grid group (Go `Groups` and the Worker `GROUPS`)
   and a Worker `PERMISSIONS` entry. Each role is granted the keys in Go
   `SystemRoles`, static_data `SYSTEM_ROLES` and `setup/common.ts`.
3. `shared/api/feature_<slug>.ts` with the item type and a `<Feature>Api`
   interface; if `shared/api/index.ts` composes `Api`, it is added there and
   the routes use `r.typed`.
4. `worker/src/routes/<module>/<slug>.ts` with `register<Feature>(r)` (GET list,
   POST create when there is a write permission), imported and called in
   `routes/index.ts`. Default path `/<module>/<slug-with-dashes>` (`--path` to
   choose); refused if the path is already in use.
5. `FEATURE_ROUTES['<id>']` so the seller switch also refuses the API (`--no-gate`
   to skip); a new section gets a `SECTION_MODULE` entry when `--plan-module`
   is given.
6. `web/src/features/<module>/<Feature>.tsx` and one registry line per key.
7. A tenant migration via the migration runner: the table (`--table y` makes
   `<slug>_items`, `--table <name>` names it), the permission rows, and the
   grants to built-in roles a school has not customised.
8. `worker/test/integration/feature_<slug>.test.ts` (routes exist under the
   right permissions; `cd worker && npx vitest run`).

Every line it adds to a shared file ends in `// feature:<id>` (blocks:
`// feature:<id> begin` ... `end`), which is how `remove` and `rename` find them.

Other flags: `--workspace`, `--scope "<Data Scope wording>"`, `--tier`,
`--priority`, `--plan-module`, `--web-dir`, `--yes` (never prompt).

## Consistency check

`npm run feature:check` verifies:

- every catalogue feature has a screen, or is listed in `docs/features-planned.txt`;
- every registry key is in the catalogue and points at a file that exists;
- every permission a route uses (literal or a `const` in the same file) is in the
  Worker permission catalogue and in Go rbac, or is a catalogue key;
- the Worker permission copy, Go `rbac.All` and `provision_seed.ts` agree, and
  static_data `SYSTEM_ROLES` agrees with `setup/common.ts`;
- the Worker's catalogue copy is not stale;
- every file under `worker/src/routes` is reachable from `worker/src/index.ts`;
- no screen under `web/src/features` is unreachable (no import reaches it);
- every `FEATURE_ROUTES` id is a catalogue feature; every manifest file exists.

Known debt is in `scripts/feature-check-baseline.json` and does not fail;
anything new does, and the check lists entries fixed since the baseline so they
can be taken out. CI runs it in `.github/workflows/worker.yml` (job `check`).

State when the check was introduced (2026-09-27): all 21 parent catalogue
features map to screens (PTM is `parent.school_life.calendar_ptm`; gallery,
library and pickup have no parent catalogue rows at all, so there is nothing to
wire until the CSV gains them). Ten AI and telematics
features have no screen and are listed as planned. 19 registry keys name
features no longer in the catalogue and 29 screens are unreachable: both are
the same lists `catalog-keys.test.ts` and `reachable.test.ts` already freeze,
and they stay in the baseline until someone decides to rewire or delete each one.

## Updating a feature safely

- **Label or summary**: edit the CSV (or `feature:rename --keep-key`, which adds a
  `FEATURE_SLUG_OVERRIDE` so the key stays), then `node scripts/feature.mjs sync`.
  The key does not change, so grants, saved links and `/go/` paths keep working.
- **Key (role, section or slug)**: `feature:rename` without `--keep-key`. It refuses
  while anything outside the places it edits names the old key and lists them.
  It rewrites the registry, switch, and (for generated features) the files and
  identifiers, and writes a migration that moves `role_permissions` to the new
  key in every school. Seller overrides in CONTROL `school_feature_overrides`
  are keyed by feature id: carry them over by hand if the id changed.
- **Permissions**: add a new key rather than changing what an existing one
  means. A key held by customised roles in live schools cannot be recalled by a
  code change. Every new key needs a roles-grid group (Go tests enforce it).
- **Schema**: new migration only (`node worker/scripts/migrate.mjs new tenant <name>`),
  additive first (new table or nullable column), code that reads both, then a
  later migration to tighten. Never edit an applied migration.
- **Response shapes**: change `shared/api` first; both sides then fail to compile
  wherever they disagree.
- Before merging: `npm run feature:check`, `cd worker && npx tsc --noEmit`,
  `cd web && npx tsc --noEmit -p .`, `go build ./... && go test ./internal/rbac`.

## Retiring a feature

1. **Deprecate.** Say so in the summary ("Being retired on <date>; use X"),
   `sync`, and stop building on it.
2. **Hide.** Switch it off per school in the seller console (Features), with an
   end date for a staged rollout. The menu entry disappears, and if its id is in
   `FEATURE_ROUTES` its API answers "switched off", while the data stays. Watch
   for complaints for at least a term.
3. **Remove.** `npm run feature:remove -- --id <section.slug>` (or `--key` for
   one role). It refuses, listing them, while other code references the key
   (links from other screens, `useFeatureHref`, tests). Then it removes the CSV
   rows, registry entries and the switch, and for generated features also the
   routes, screen, shared types, permissions it created, grants and group, and
   regenerates everything. `--dry-run` only lists references.
4. **Data retention.** Tables are left in place by default. The retirement
   migration deletes the feature's permission rows and grants, and holds the
   `DROP TABLE` commented out. Export the school's data first (seller console,
   school export), keep it for the retention period the school's contract and
   the DPDP Act require, then run
   `feature:remove -- --id <id> --drop-tables` (or write the drop migration) to
   delete it. A create migration that was never committed was never applied
   anywhere, so `remove` deletes it outright; a committed one stays, because
   migrations are forward-only.
