#!/usr/bin/env bash
# Run before ANY deploy (Worker or Pages). Refuses when the tree being deployed
# is missing commits someone else has pushed, so a deploy can never roll back
# another person's work. See CLAUDE.md "Deploying".
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin
fail=0
for b in origin/main origin/cloudflare-workers; do
  git rev-parse -q --verify "$b" >/dev/null || continue
  n=$(git rev-list --count HEAD.."$b")
  if [ "$n" != 0 ]; then echo "deploy-guard: HEAD is missing $n commit(s) from $b -- merge them first:"; git log --oneline HEAD.."$b" | head -10; fail=1; fi
done
if git ls-files -u | grep -q .; then echo "deploy-guard: unresolved merge conflicts"; fail=1; fi
[ $fail = 0 ] && echo "deploy-guard: OK, $(git rev-parse --short HEAD) contains origin/main and origin/cloudflare-workers"
exit $fail
