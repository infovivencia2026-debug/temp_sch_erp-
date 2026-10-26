# Rules for everyone working in this repo (people and AI sessions)

Several people and Claude sessions work here at once. These rules keep them
from undoing each other. They run in order: start, develop, integrate,
deploy, promote, maintain. The UI and wording rules below them apply to all
work.

## Branches

| Branch | What it is | Who moves it |
|---|---|---|
| `main` | The one source of truth. The live Pages project `school-erp` builds from it. | Every session pushes here after checks |
| `cloudflare-workers` | Always equal to `main`. A push deploys the Worker `school-erp` and the test Pages site `school-erp-d1`. | The integrating session, at deploy |
| `generic/test`, `generic/pre-deploy`, `generic/production` | The white-label release, by stage | The integrating session, fast-forward only |
| `yajur/test`, `yajur/pre-deploy`, `yajur/production` | One school's release, by stage. May hold that school's own commits (config, seed). | The integrating session |
| `<topic>` (e.g. `seller-sales`) | One piece of work, short-lived | Its own session |

No other long-lived branches. A topic branch is merged into `main` and
deleted on `origin` the same day it is done. Never push straight to a
`*/production` branch.

## 1. Start

- **Your own folder.** `git fetch origin`, then
  `git worktree add ../erp-<topic> -b <topic> origin/main`. Never work in a
  checkout another session is using.
- **In a shared checkout,** commit only your own hunks. Never `git add -A`,
  `git stash`, `reset --hard`, or switch branches there.
- **Record the ask.** `docs/owner-requests.md` is the one list of what the
  owner asked and its status. Add or update its line in the same commit as
  the work. If your work changes something another session built, mark it
  under "Clash" instead of silently replacing it.

## 2. Develop

- **Migrations.** Create them with `cd worker && npm run migrate -- new tenant
  <name>` (or `control`), never by hand. Run `git fetch` and
  `ls worker/migrations/tenant | tail` on `origin/main` first: numbers move
  fast. If a merge brings two files with one number, renumber YOURS to the
  next free number. Never change a migration that `main` already has (its
  checksum is recorded). Then run `npm run schema:sync`.
- **Generated files are rebuilt, never hand-edited or hand-merged:**
  `internal/catalog/catalog_gen.go`, `internal/api/implemented_gen.go`,
  `internal/api/help_answers_gen.go`, `web/src/catalog.gen.ts`,
  `worker/src/services/provision_seed.ts`, `CATALOG_ROLES` and
  `IMPLEMENTED_FEATURES` in `worker/src/routes/admin/static_data.ts`,
  `worker/db/*.sql`, `worker/src/services/tenant_migrations.ts`. Change the
  source (`docs/edu_features.csv`, `internal/rbac`, migrations), then run
  `node scripts/feature.mjs sync` and `npm run schema:sync`. On a conflict
  in a generated file, take either side, then rebuild it.
- **Paths are forward slashes** in every file the repo stores (manifests,
  JSON, docs). CI runs on Linux; `worker\migrations\...` written on
  Windows fails it.
- **Commit small and often**, with a message saying what changed and why.
  Put school-specific config only on that school's branch, never on `main`.

## 3. Integrate (every session, before pushing to `main`)

1. `git fetch origin` and merge `origin/main` into your branch. Resolve
   conflicts by keeping both sides' changes. When one side is clearly a
   later version of the same work, keep that one and say so in the merge
   commit.
2. Checks on that exact tree, all passing:
   `cd web && npx tsc --noEmit -p .`;
   `cd worker && npx tsc --noEmit -p . && npm run -s schema:check && npx vitest run test/integration`;
   `node scripts/feature.mjs check`.
3. Push to `main` (`git push origin HEAD:main`). If it is refused, someone
   pushed first: go back to step 1.
4. Delete your topic branch on `origin` once it is in `main`.

## 4. Deploy (the integrating session only)

One session is the integrating session. It merges, verifies on the test site
and deploys. Others push to `main` and leave deploys to it unless the owner
says otherwise.

1. Work from a clean worktree at `origin/main`, with `origin/cloudflare-workers`
   merged in.
2. CI on `main` is green (`gh run list -b main -L 3`). A red CI on `main` is
   fixed before any new feature is deployed.
3. Migrations first: `cd worker && node scripts/migrate.mjs up --remote`.
4. `scripts/deploy-guard.sh` says OK. It refuses while CONTROL or any school
   has pending remote migrations (`scripts/deploy-preflight.sh`). Set
   `ALLOW_PENDING_MIGRATIONS=1` only when the new code does not need them.
   Never deploy past a failing guard.
5. Deploy by pushing the same commit to both: `git push origin HEAD:main
   HEAD:cloudflare-workers`. The `worker` workflow tests it and deploys the
   Worker and the test site. Watch it finish (`gh run watch`). A red run
   means nothing was deployed; fix it on `main` and push again.
6. Check every item that went out on the test site. The test site always
   equals `main`.
7. Do not deploy the live Pages project `school-erp` by hand.

## 5. Promote (the integrating session only)

The release branches are moved from `main`, one stage at a time:
`main` -> `*/test` -> `*/pre-deploy` -> `*/production`.

- `generic/*`, and `yajur/pre-deploy` and `yajur/production`, only
  fast-forward: `git push origin <commit>:refs/heads/<branch>`. If a
  fast-forward is refused, the branch holds commits `main` lacks: stop and
  find out why. Never force-push.
- `yajur/test` takes `main` by a merge (it keeps the school's own commits),
  checks pass on the merged tree, then push it.
- A stage moves on only after the one before it has been checked. Moving a
  `*/production` branch is a release: the owner says when.

## 6. Maintain

- **Weekly:** `git fetch --prune`. Delete branches on `origin` that are fully
  in `main` (`git rev-list --count origin/main..origin/<b>` is 0). For any
  that are not, merge them or ask their owner; never delete unmerged work
  without looking at it.
- **Worktrees:** remove yours when the work is in `main`
  (`git worktree remove ../erp-<topic>`).
- **CI:** a red run on `main` or `cloudflare-workers` is the next job for
  whoever sees it first.
- **Backups:** `d1-backup` and `nightly-backup` run nightly. Check that they
  are green after any migration that drops or rewrites data.
- **Owner list:** keep `docs/owner-requests.md` current. A line says Done
  only with how it was verified.

## UI rules (owner's decisions; follow them in every screen)

Reference: `docs/ui-elements.md` (every element and its status), `docs/motion-kit.md`,
`web/src/styles/color-system.css`, `web/src/styles/page-foot.css`. The Elements
gallery (`?elements=1`) is the living checklist: add every new variant to it.

- **Shared components only.** Button, Input, Textarea, PickerMenu, Badge, Dialog,
  Card, Stat, Table, EmptyState and the shared tab styles from `components/ui.tsx`.
  No hand-rolled buttons, inputs, pills, selects or dialogs.
- **Sizes.** Controls 40px on desktop, 48px on phones (phone = below 640px; block at the end of web/src/index.css). Phone type scale (owner, 2026-10-24): body 16, secondary 14, caption 12, button/input text 16, title 24, section 20; fields 52, radius 12, icons 24, targets >= 48. Phone gutters 16px. No
  horizontal page scroll. Long text truncates with an ellipsis or wraps on purpose.
- **Dropdowns** (owner, 2026-10-24: "next time I should not see this type of bug"). One shared component: Select or PickerMenu (DropdownRow in settings). On phones (< 640px) the field is a 52px button with a chevron and opens the shared bottom sheet (components/OptionSheet.tsx); a short fixed list never shows a caret or the keyboard; only a list longer than 12, an empty one, or one that adds its own (kind / allowCustom) gets a search box, inside the sheet. Desktop keeps the anchored popover, clamped on screen. No hand-rolled selects, datalists, comboboxes or listbox popovers: components/dropdown-guard.test.ts fails on them.
- **Fields.** Every field (dropdown, input, textarea) is a visible frosted box (owner 2026-10-26, "why all dropdowns box disappeared???"): `.field` in index.css, translucent card + 10px blur + token border that shows on white; hover lift + primary border + glow, also on press/focus/open on phones.
  Text areas grow with their content.
- **Colour.** Tokens only. Solid system colours (`--sys-*`) where they mean
  something: one primary action per screen, destructive, status, switches,
  the active tab, a workspace's accent. Everything else neutral. The school's
  brand colour wins where set. Works in dark and in every palette.
- **Icons.** Minimal line icons; no glassy or solid-colour icon tiles. App icons
  use the All features disc, with a one-word label. No two icons alike in a dock.
- **Search highlights.** Slightly bolder only: no underline, no box.
- **Bottom space.** Reserved once, from `--page-foot`. Never add a page's own
  bottom padding for the dock, tab bar or assistant.
- **Motion.** From the kit only; transform and opacity; never cut off part-way;
  entrances once per mount, not on refetch; instant under reduced motion.
- **Haptics.** `buzz()` only at decisions (long-press, drop, page landing, sheet
  commit, destructive confirm, Saved). Never on plain taps.
- **Saving.** Show the result at once with `lib/optimistic.ts` for low-risk
  actions, with rollback and Retry. Money, logins, publishing and admissions
  wait for the server.
- **White label.** Nothing school-specific in the source. "XULO" only where the
  vendor is meant.
- **Phone first.** Check 360 and 390 wide, light and dark, before calling a
  screen done.

## No filler (owner: "no AI slop", "make no errors")

- **Words on screen.** Plain, specific and short, written for a school office:
  say what the thing does and what to do next. No marketing tone, no
  "Welcome to your dashboard!", no "seamlessly", "effortlessly", "powerful",
  no emoji, no exclamation marks, no placeholder or lorem text, no invented
  numbers or sample names shipped as real content. Help articles and canned
  replies name the actual screen and button.
- **Design.** No decoration without a job: no gradient-for-its-own-sake, stock
  illustration, sparkle icon, generic three-card feature row or badge that
  says nothing. Every element on a screen must be something the user reads
  or presses.
- **Code.** No dead buttons, stubs, TODOs, commented-out blocks, unused props
  or copy-pasted variants. If a part is not finished, leave it out of the UI
  and say so in the report.
- **Verification.** A screen is done when it has been opened and used in a
  browser at phone and desktop size, light and dark, with no console errors
  and no failed requests; a route when its tests cover the refusals too.
  Reports say which items were verified in a browser and which were only
  type-checked.
