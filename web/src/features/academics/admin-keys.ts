import { screen } from '@/lib/screen'
import { lazy } from 'react'

/* The principal's academic and student screens.

   Kept out of registry.ts so this batch can be added without several agents
   editing one map at once. Spread into FEATURE_COMPONENTS there.

   Every key below is one that catalog_gen.go already carries. A key the
   catalogue lacks renders the honest placeholder instead of the screen, which
   is a silent way to lose a feature that looks finished from the code. */
export const adminAcademicsKeys = {
  'institution_admin.academics.school_calendar': screen(() => import('./AcademicCalendar')),
  'institution_admin.academics.substitutions': lazy(
    () => import('./SubstitutionBoard'),
  ),

}
