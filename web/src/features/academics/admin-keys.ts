import { screen } from '@/lib/screen'

/* The principal's academic and student screens.

   Kept out of registry.ts so this batch can be added without several agents
   editing one map at once. Spread into FEATURE_COMPONENTS there.

   Every key below is one that catalog_gen.go already carries. A key the
   catalogue lacks renders the honest placeholder instead of the screen, which
   is a silent way to lose a feature that looks finished from the code. */
export const adminAcademicsKeys = {
  'institution_admin.academics.school_calendar': screen(() => import('./AcademicCalendar')),
  /* screen(), like everything else, and not a bare lazy().
   *
   * A bare lazy() is one network request with no second chance: React caches
   * the rejected promise, so a single blip -- a phone changing cell, the front
   * desk wifi, a proxy dropping the connection -- kills this screen for the
   * life of the tab. Clicking the menu entry again re-shows the same failure,
   * and the page simply never arrives. That is exactly the fault screen() was
   * written for, and this was the one entry not using it.
   *
   * The line above it always did. */
  'institution_admin.academics.substitutions': screen(
    () => import('./SubstitutionBoard'),
  ),

}
