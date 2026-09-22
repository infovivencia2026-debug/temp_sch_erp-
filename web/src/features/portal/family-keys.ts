import { screen } from '@/lib/screen'
import { lazy } from 'react'

/* The family's school-life, support-plan, identity, alert and canteen screens,
   keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go before it
   was written. A key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable without a single error to say why.

   Two catalogue entries never share a component. Calendar and PTM booking are
   separate files even though one page could serve both, because a menu with two
   entries that open the same screen is how a parent concludes the app is
   broken — the mistake Reminders and My day made before they were split.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in alongside parentKeys
   and runs `make catalog` so internal/api/implemented_gen.go agrees with it. */
export const familyKeys = {
  'parent.school_life.calendar_ptm': screen(() => import('./Calendar')),
  'parent.profile.digital_student_id_card_view': screen(() => import('./StudentIDCard')),

  /* Language, theme and contrast are one panel a person opens once, under the
     Language row. The screen lives under learning/ because a student reaches
     it too -- same preferences, same row. */
  'parent.profile.language': lazy(
    () => import('../learning/ThemeSelection'),
  ),
  // The child's digital money: the school-held prepaid balance and its ledger.
  'parent.fees.wallet': screen(() => import('./Wallet')),
}
