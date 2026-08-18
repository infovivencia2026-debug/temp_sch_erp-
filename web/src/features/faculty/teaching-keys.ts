import { lazy } from 'react'

/* The teaching workspace, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go at the
   commit this was written on. A key the catalogue does not carry renders the
   honest "catalogued, not implemented" placeholder instead of the screen, and
   the screen is then unreachable without a single error to say why.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it.

   Study materials and the LMS upload are two entries over one table: the first
   finds and withdraws, the second adds. They are separate catalogue keys, so
   they are separate screens, but there is only one study_materials row behind
   both and no way for them to disagree. */
export const teachingKeys = {
  'faculty.teaching.assignments_submissions': lazy(() => import('./Assignments')),
  'faculty.teaching.study_materials': lazy(() => import('./StudyMaterials')),
  'faculty.teaching.lms_study_material_upload': lazy(() => import('./LMSUpload')),
  'faculty.teaching.live_virtual_class_launcher': lazy(() => import('./VirtualClasses')),
  'faculty.question_papers_online_tests.question_bank_management': lazy(
    () => import('./QuestionBank'),
  ),
  'faculty.question_papers_online_tests.objective_online_test_creation': lazy(
    () => import('./OnlineTests'),
  ),
  'faculty.assessment_schemes.cce_formative_assessment_entry': lazy(
    () => import('./CCEFormative'),
  ),
  'faculty.assessment_schemes.cce_summative_assessment_entry': lazy(
    () => import('./CCESummative'),
  ),
}
