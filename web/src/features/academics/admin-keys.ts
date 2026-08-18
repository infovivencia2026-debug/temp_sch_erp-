import { lazy } from 'react'

/* The principal's academic and student screens.

   Kept out of registry.ts so this batch can be added without several agents
   editing one map at once. Spread into FEATURE_COMPONENTS there.

   Every key below is one that catalog_gen.go already carries. A key the
   catalogue lacks renders the honest placeholder instead of the screen, which
   is a silent way to lose a feature that looks finished from the code. */
export const adminAcademicsKeys = {
  'institution_admin.academics.academic_calendar': lazy(() => import('./AcademicCalendar')),
  'institution_admin.academics.exams_marks_monitoring': lazy(() => import('./ExamMonitoring')),
  'institution_admin.academics.faculty_allocation': lazy(() => import('./FacultyAllocation')),
  'institution_admin.academics.faculty_substitution_engine': lazy(
    () => import('./SubstitutionBoard'),
  ),
  'institution_admin.academics.obe_outcomes': lazy(() => import('./Outcomes')),

  'institution_admin.students.department_students': lazy(
    () => import('../students/DepartmentStudents'),
  ),
  'institution_admin.students.disciplinary_incident_log': lazy(
    () => import('../students/DisciplineLog'),
  ),
  'institution_admin.students.student_council_management': lazy(
    () => import('../students/StudentCouncil'),
  ),
  'institution_admin.students.alumni_program_oversight': lazy(
    () => import('../students/Alumni'),
  ),
  'institution_admin.students.certificates_document_templates': lazy(
    () => import('../students/CertificateTemplates'),
  ),
}
