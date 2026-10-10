import { screen } from '@/lib/screen'
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
  'student.learning.courses_subjects': screen(() => import('../learning/SubjectsSyllabus')), // the year's subjects and their syllabus (owner, 2026-10-10)
  /* The LMS is the courses: Subjects > Modules (with modules inside them) >
     content. Both menu entries open the same screen; what used to be the
     flat "Shared with you" list (learning/Resources.tsx) now shows inside
     its subject, or on the subjects page when it names none. */
  'student.learning.e_learning_resource_hub': screen(() => import('../learning/StudentCourses')), // LMS = the courses the LMS admin builds, day- or topic-wise (owner, 2026-10-10)
  'student.notices_calendar.calendar': screen(() => import('./StudentCalendar')),
  'student.notices_calendar.library_book_hold_request': lazy(
    () => import('../learning/LibraryHolds'),
  ),
  'student.exams_results.academic_record': screen(() => import('./StudentRecord')),
}
