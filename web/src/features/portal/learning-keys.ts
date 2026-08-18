import { lazy } from 'react'

/* The child's own screens, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go before it
   was written. A key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable without a single error to say why — a sibling
   agent lost six screens to exactly that, having read a catalogue twelve
   migrations stale.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const learningKeys = {
  'student.learning.courses_subjects': lazy(() => import('../learning/Courses')),
  'student.learning.e_learning_resource_hub': lazy(() => import('../learning/Resources')),
  'student.learning.peer_tutoring_study_groups': lazy(() => import('../learning/StudyGroups')),
  'student.learning.student_portfolio_management': lazy(() => import('../learning/Portfolio')),
  'student.learning.global_university_guidance_counselor': lazy(
    () => import('../learning/Universities'),
  ),
  'student.campus_life.lost_found_item_board': lazy(() => import('../learning/LostFound')),
  'student.campus_life.digital_locker_combination_access_log': lazy(
    () => import('../learning/Locker'),
  ),
  'student.campus_life.student_club_event_ticketing_qr_check_in': lazy(
    () => import('../learning/ClubEvents'),
  ),
  'student.notices_calendar.calendar': lazy(() => import('../learning/Calendar')),
  'student.notices_calendar.library_book_hold_request': lazy(
    () => import('../learning/LibraryHolds'),
  ),
  'student.exams_results.academic_record': lazy(() => import('../learning/AcademicRecord')),
  'student.exams_results.apaar_id_academic_bank_of_credits': lazy(
    () => import('../learning/CreditBank'),
  ),
  'student.alumni.alumni_network_registration': lazy(() => import('../learning/AlumniNetwork')),
  'student.alumni.alumni_job_internship_board': lazy(() => import('../learning/AlumniJobs')),
}
