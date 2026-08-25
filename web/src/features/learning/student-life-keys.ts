import { screen } from '@/lib/screen'
import { lazy } from 'react'

/* The six student-life screens, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go before
   it was written. A key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable without a single error to say why.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it.

   Two of these sit next to screens that already exist and are deliberately not
   folded into them:

     lost_found_photo_board_with_claim_verification is a second screen beside
     the existing lost_found_item_board rather than a rewrite of it. The board
     is a noticeboard anyone can read; this is the evidence-and-release flow,
     which shows claim answers to the finder and the office and to nobody else.
     Putting both on one page would have meant one screen with two audiences.

     virtual_classroom_hand_raise_telemetry reads the virtual_class_sessions a
     teacher already schedules through the live-class launcher. There is no
     second session model, and no video: this is the record, not the stream. */
export const studentLifeKeys = {
  /* The child's own identity card.

     A parent could see their child's card and the child could not see their
     own: the student's entry was the NFC tap pass, which needs a reader the
     school may not own, so it was catalogued and never built. The card itself
     needs no hardware — it is the same screen the parent opens, and
     useChildren returns a student their own record. */
  'student.profile.my_id_card': screen(() => import('../portal/StudentIDCard')),

  'student.campus_life.lost_found_photo_board_with_claim_verification': lazy(
    () => import('./LostFoundClaims'),
  ),
  'student.campus_life.student_wall_peer_recognition': screen(() => import('./StudentWall')),
  'student.home.digital_diary_schedule': screen(() => import('./Diary')),
  'student.home.custom_theme_selection': screen(() => import('./ThemeSelection')),
  'student.homework.classmate_homework_help_forum': screen(() => import('./HomeworkForum')),
  'student.learning.virtual_classroom_hand_raise_telemetry': screen(() => import('./HandRaise')),
}
