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
  /* Was a second entry opening the identical leave screen.
   *
   * Leave & Absence carried "Requests" and "Apply Student Leave", both
   * rendering LeaveRequests — the duplication this file's own header warns
   * about, and the one that makes a parent conclude the app is broken. What
   * its description actually promised was certificates, which had a working
   * screen and no way for a parent to reach it at all. So it moved to
   * Documents and now opens the screen it always described. */
  'parent.documents.certificate_requests': screen(() => import('./Requests')),
  'parent.leave_absence.apply_student_leave': screen(() => import('./LeaveRequests')),
  'parent.attendance.child_absence_reporting_button': screen(() => import('./ReportAbsence')),
  'parent.consent.parent_delegation_for_emergency_pickup': screen(() => import('./Pickup')),
  'parent.messages.direct_teacher_messaging': screen(() => import('./TeacherMessages')),
  'parent.messages.teacher_remarks': screen(() => import('../shared/StaffRemarks')),
  'parent.academics.child_remarks': screen(() => import('./ChildRemarks')),
  'parent.fees.fee_receipts': screen(() => import('./Receipts')),
  /* A student applying for their own leave.
   *
   * This existed only on the parent's menu, so a sixteen-year-old had to ask a
   * guardian to file something the school expects them to file themselves —
   * and the Requests screen next door, whose description promises "leave,
   * certificate, bonafide", in fact only ever offered certificates.
   *
   * Same screen as the parent's. The endpoint already allowed it: a student's
   * own record is in their own scope, so there was nothing to permit, only a
   * door to open. */
  'student.attendance.apply_for_leave': screen(() => import('./LeaveRequests')),
  'student.requests.requests': screen(() => import('./Requests')),
}
