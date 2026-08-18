import { lazy } from 'react'

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
  'parent.leave_absence.requests': lazy(() => import('./LeaveRequests')),
  'parent.leave_absence.apply_student_leave': lazy(() => import('./LeaveRequests')),
  'parent.attendance.child_absence_reporting_button': lazy(() => import('./ReportAbsence')),
  'parent.consent.parent_delegation_for_emergency_pickup': lazy(() => import('./Pickup')),
  'parent.messages.concerns_grievance_ticketing': lazy(() => import('./Concerns')),
  'parent.messages.direct_teacher_messaging': lazy(() => import('./TeacherMessages')),
  'parent.fees.digital_fee_receipt_pdf_download': lazy(() => import('./Receipts')),
  'student.requests.requests': lazy(() => import('./Requests')),
  'student.requests.documents': lazy(() => import('./Documents')),
}
