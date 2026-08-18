import { lazy } from 'react'

/**
 * The staff lifecycle screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the four components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Four components, fifteen keys. The catalogue splits by feature because that
 * is how a school buys; the screens are grouped by the conversation somebody
 * actually has — one about joining and leaving, one about the records an
 * inspection asks for, one about welfare, one about leave rules. Fifteen
 * separate screens would each show a fifteenth of an answer.
 */
export const hrLifecycleKeys = {
  'hr.onboarding_exit.staff_onboarding_kyc_verification': lazy(() => import('./Lifecycle')),
  'hr.onboarding_exit.staff_exit_interview_management': lazy(() => import('./Lifecycle')),
  'hr.onboarding_exit.staff_experience_relieving_cards': lazy(() => import('./Lifecycle')),
  'hr.onboarding_exit.teacher_relieving_no_deduction_clearance': lazy(() => import('./Lifecycle')),
  'hr.onboarding_exit.teacher_transfer_deputation': lazy(() => import('./Lifecycle')),

  'hr.records.staff_service_book_digitalization': lazy(() => import('./ServiceRecords')),
  'hr.records.teacher_qualification_register': lazy(() => import('./ServiceRecords')),
  'hr.verification.medical_fitness_certificate_registry': lazy(() => import('./ServiceRecords')),
  'hr.verification.staff_criminal_background_verification': lazy(() => import('./ServiceRecords')),

  'hr.welfare.staff_birthday_anniversary_alerts': lazy(() => import('./Welfare')),
  'hr.welfare.staff_grievance_cell': lazy(() => import('./Welfare')),
  'hr.welfare.staff_recognition_wall': lazy(() => import('./Welfare')),

  'hr.leave.leave_policy_configuration': lazy(() => import('./LeavePolicy')),
  'hr.leave.half_day_leave_deduction_calculation': lazy(() => import('./LeavePolicy')),
  'hr.leave.late_arrival_loss_of_pay_lop': lazy(() => import('./LeavePolicy')),
}
