import { lazy } from 'react'

/* The classroom workspace, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go at the
   commit this was written on. A key the catalogue does not carry renders the
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable with nothing to say why.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it.

   One note for whoever reads the offline entry and expects a PWA. The register
   screen queues in localStorage and replays on reconnect, and the server side
   of the sync is complete — idempotent batches, and a refusal to overwrite a
   mark somebody else entered. What it is not is an installable offline app:
   there is no service worker in this project, so the page still has to load
   from the network. The screen says so on its face rather than implying
   otherwise. */

export const classroomKeys = {
  'faculty.my_classes.language_subject_allocation': lazy(
    () => import('./LanguageAllocation'),
  ),
  'faculty.my_classes.student_portfolio_builder': lazy(
    () => import('./PortfolioBuilder'),
  ),
  'faculty.my_classes.montessori_early_years_tracking': lazy(
    () => import('./MontessoriTracking'),
  ),
  'faculty.attendance.offline_attendance_diary_capture': lazy(
    () => import('./OfflineRegister'),
  ),
  'faculty.question_papers_online_tests.no_omr_exam_grading': lazy(
    () => import('./ExamGrading'),
  ),
}
