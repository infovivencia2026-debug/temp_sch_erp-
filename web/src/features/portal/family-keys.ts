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
  'parent.school_life.parent_teacher_meeting_booking': screen(() => import('./PTM')),
  'parent.school_life.school_photo_video_gallery': screen(() => import('./Gallery')),
  'parent.school_life.live_event_seating_pass': screen(() => import('./EventPasses')),
  'parent.academics.iep_progress_goal_tracker': screen(() => import('./IEPGoals')),
  'parent.profile.digital_student_id_card_view': screen(() => import('./StudentIDCard')),
  'parent.profile.digital_parent_id_card_for_campus_entry': screen(() => import('./ParentIDCard')),

  /* The display-preferences screen serves three catalogue rows and one screen.
     Language, theme and contrast are one panel a person opens once; splitting
     them into three pages to match three keys would be the catalogue shaping
     the product rather than describing it. The screen lives under learning/
     because a student reaches it too -- same preferences, same row. */
  'parent.profile.multi_language_app_interface_toggle': lazy(
    () => import('../learning/ThemeSelection'),
  ),
  'parent.profile.telugu_language_interface': lazy(
    () => import('../learning/ThemeSelection'),
  ),
  'parent.profile.parent_app_dark_mode_high_contrast_accessibility': lazy(
    () => import('../learning/ThemeSelection'),
  ),
  'parent.fees.child_daily_cafeteria_purchase_timeline': screen(() => import('./Cafeteria')),
}
