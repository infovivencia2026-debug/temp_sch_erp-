import { screen } from '@/lib/screen'

/* The family's request, consent and message screens, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go before it
   was written. A key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable without a single error to say why — a sibling
   agent lost six screens to exactly that, having read a catalogue twelve
   migrations stale.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const parentKeys = {
  'parent.leave_absence.requests': screen(() => import('./LeaveRequests')),
  'parent.leave_absence.apply_student_leave': screen(() => import('./LeaveRequests')),
  'parent.attendance.child_absence_reporting_button': screen(() => import('./ReportAbsence')),
  'parent.consent.parent_delegation_for_emergency_pickup': screen(() => import('./Pickup')),
  'parent.messages.direct_teacher_messaging': screen(() => import('./TeacherMessages')),
  'parent.messages.teacher_remarks': screen(() => import('../shared/StaffRemarks')),
  'parent.academics.child_remarks': screen(() => import('./ChildRemarks')),
  'parent.fees.digital_fee_receipt_pdf_download': screen(() => import('./Receipts')),
  'student.requests.requests': screen(() => import('./Requests')),
}
