import { lazy } from 'react'

/* Hiring, appraisal, training and duty rostering, keyed by catalogue feature.

   Kept beside the screens rather than pasted into registry.ts so this module
   and the four components it names move together, and so several agents are
   not editing one map at once. Spread into FEATURE_COMPONENTS there;
   scripts/gen_implemented.py reads registry.ts, so the server only marks these
   live once the spread is in place.

   Four keys, four screens — unusually, one each. These features share a
   subject and almost nothing else: hiring is a funnel, an appraisal is a
   scored form with four hands on it, training is a compliance report, and a
   roster is a calendar. Folding any two together would have produced a screen
   that answers half of two questions.

   Every key below is one catalog_gen.go already carries. A key the catalogue
   lacks renders the honest placeholder instead of the screen, which is a
   silent way to lose a feature that looks finished from the code. */
export const hrGrowthKeys = {
  'hr.attendance.staff_shift_rostering': lazy(() => import('./Rostering')),
}
