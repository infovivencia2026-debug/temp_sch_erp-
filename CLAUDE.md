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
