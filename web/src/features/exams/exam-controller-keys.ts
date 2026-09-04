import { screen } from '@/lib/screen'

/**
 * The examination controller's workspace, keyed by catalogue feature.
 *
 * The rbac role held ExamsRead/Write, MarksWrite and ReportCardsGenerate and
 * the catalogue held nothing for it, so a person given only this role signed
 * in to "No workspace". Every screen here already existed under the
 * principal's Examinations group; these keys reach the same components.
 *
 * Marks entry (exams/Gradebook) is deliberately absent: its section picker
 * asks for `sections?mine=true`, which answers only for somebody who teaches
 * or holds attendance.write.any, and the exam office holds neither.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the keys here. Keys checked against internal/catalog/catalog_gen.go.
 */
export const examControllerKeys = {
  'exam_controller.home.exam_desk': screen(() =>
    import('../bento/ExamDesk').then((m) => ({ default: m.Classic })),
  ),
  'exam_controller.examinations.exams_papers': screen(() => import('./Exams')),
  'exam_controller.examinations.hall_tickets_seating': screen(() => import('./HallTicket')),
  'exam_controller.examinations.report_cards': screen(() => import('./ReportCards')),
  'exam_controller.examinations.performance_overview': screen(() => import('./PerformanceOverview')),
  'exam_controller.my_profile.profile': screen(() => import('../shared/Profile')),
  'exam_controller.my_profile.my_pay': screen(() => import('../me/MyPay')),
}
