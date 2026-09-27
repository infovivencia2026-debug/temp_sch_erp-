import type { Router } from '../../router'
import { registerDrafting } from './drafting'
import { registerBriefs } from './briefs'

/* "AI native" part 2: Write with AI (drafting, translation) and the briefs. */
export function registerAi(r: Router): void {
  registerDrafting(r)
  registerBriefs(r)
}
