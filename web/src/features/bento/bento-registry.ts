import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A BENTO SCREEN — the whole opt-in, in one line.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1. Write `web/src/features/bento/<Screen>.tsx`, a NEW file, default
 *      exporting a component that takes no props.
 *   2. Add one line to BENTO_COMPONENTS below, keyed by the SAME catalogue
 *      feature key the classic screen is registered under in
 *      `web/src/features/registry.ts`:
 *
 *          'faculty.home.my_work': lazy(() => import('./MyWork')),
 *
 * That is the entire contract. You do not touch registry.ts, App.tsx,
 * Shell.tsx, ui.tsx, or the classic screen — the classic file is not opened.
 * A key absent from this map falls through to the classic screen silently, so
 * a school on the Bento layout meets the product as it ships today for every
 * screen nobody has converted yet, and never a blank one.
 *
 * WHY A MAP AND NOT A `.bento.tsx` SIBLING CONVENTION. A filename convention
 * needs a bundler glob (`import.meta.glob`) to discover files, which ties the
 * seam to Vite's resolver and makes "does this screen have a Bento variant?"
 * a question you answer by listing a directory. This map answers it by being
 * read, is greppable, and is a plain module that `npx tsc --noEmit` checks —
 * which matters on a machine where the bundler cannot be run.
 *
 * WHY THIS FILE RATHER THAN registry.ts. registry.ts is a contention point:
 * the agent contract forbids editing it, and `scripts/gen_implemented.py`
 * parses it to decide what the server may mark `live`. A Bento variant is not
 * a new feature — the feature is already live, this is a second rendering of
 * it — so it must not appear there or the generator would be told about a
 * screen twice.
 *
 * WHAT A BENTO SCREEN MAY NOT DO. It may not edit anything the classic layout
 * renders: not `ui.tsx`, not a token, not a shared component, not the classic
 * screen beside it. If it needs something from a shared component it copies or
 * wraps. See `docs/BENTO_UI_CONTRACT.md`.
 */
export const BENTO_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  /* The smoke test, and for now the only entry: proof that the switch reaches
     a screen end to end and that every other key falls through. A later
     worker replaces this with the real thing. */
  'faculty.home.my_work': lazy(() => import('./MyWork')),

  /* The two money-and-oversight roles. Keyed by the catalogue key the classic
     screen is registered under in registry.ts — `institution_admin.home.dashboard`,
     not `institution_admin.home.executive_kpis`, which is not a key this
     catalogue holds. */
  'institution_admin.home.dashboard': lazy(() => import('./PrincipalDashboard')),
  'finance.home.finance_kpis': lazy(() => import('./FinanceDashboard')),
}

/** The Bento rendering of a feature key, or undefined — which means "render
    the classic screen", never "render nothing". */
export function bentoComponentFor(key: string) {
  return BENTO_COMPONENTS[key]
}
