# Rules for everyone working in this repo (people and AI sessions)

## Deploying -- never roll back someone else's work

Several people and sessions push to `main` and `cloudflare-workers` at once.
A deploy from a tree that lacks their commits silently removes their work
from the live site. So, for EVERY deploy (Worker, Pages test site, live):

1. `git fetch origin` and merge BOTH `origin/main` and `origin/cloudflare-workers`
   into what you deploy. Resolve conflicts by keeping both sides' changes.
2. Run `scripts/deploy-guard.sh`. It must say OK. Never deploy if it fails.
3. Checks must pass on that exact tree: `cd web && npx tsc --noEmit -p .`,
   `cd worker && npx tsc --noEmit -p . && npx vitest run test/integration`.
4. Deploy from a clean tree (a `git worktree`), not one with uncommitted
   edits from another session.
5. Push what you deployed (`HEAD:main` and `HEAD:cloudflare-workers`) right
   after, so the next deployer starts from it.

Targets: test site = Pages project `school-erp-d1`; Worker = `school-erp`.
The live Pages project `school-erp` builds from `main` -- do not deploy to it by hand.

## Shared folder

Another session may be editing the same checkout. Commit only your own hunks;
never `git add -A`, `git stash`, `reset --hard` or switch branches there.

## UI rules (owner's decisions; follow them in every screen)

Reference: `docs/ui-elements.md` (every element and its status), `docs/motion-kit.md`,
`web/src/styles/color-system.css`, `web/src/styles/page-foot.css`. The Elements
gallery (`?elements=1`) is the living checklist: add every new variant to it.

- **Shared components only.** Button, Input, Textarea, PickerMenu, Badge, Dialog,
  Card, Stat, Table, EmptyState and the shared tab styles from `components/ui.tsx`.
  No hand-rolled buttons, inputs, pills, selects or dialogs.
- **Sizes.** Controls 40px on desktop, 44px on phones. Phone gutters 16px. No
  horizontal page scroll. Long text truncates with an ellipsis or wraps on purpose.
- **Fields.** No borders on inputs or search boxes: the soft `--field-shadow`.
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
