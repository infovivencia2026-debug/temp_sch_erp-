import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * Maps a catalog feature key to the component that implements it.
 *
 * The catalog has 419 entries; this map holds the ones with a real screen and
 * a real endpoint behind them. Anything absent renders the honest placeholder
 * in FeatureRoute — a catalogued-but-unbuilt feature says so, rather than
 * showing invented data that looks live.
 *
 * This file is the single source of truth for "what is built".
 * scripts/gen_implemented.py parses it to generate internal/api/implemented_gen.go,
 * so the navigation dots the server marks `live` can never disagree with what
 * the client can actually render. Run `make catalog` after editing.
 */
export const FEATURE_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  'institution_admin.students.student_directory_student_360': lazy(() => import('./shared/StudentProfile')),
  'institution_admin.academics.academic_structure': lazy(() => import('./shared/Academics')),
  'super_admin.institution_setup.institutions_campuses': lazy(() => import('./setup/Wizard')),
  'super_admin.institution_setup.academic_year_defaults': lazy(() => import('./setup/Wizard')),
  'super_admin.platform_configuration.data_operations': lazy(() => import('./setup/ImportStudents')),
  'institution_admin.students.enrollment_lifecycle': lazy(() => import('./lifecycle/Certificates')),
  'super_admin.access_security.users': lazy(() => import('./super_admin/Users')),
  'super_admin.access_security.roles_permissions': lazy(() => import('./super_admin/RolesPermissions')),
  'super_admin.platform_configuration.module_configuration': lazy(() => import('./super_admin/ModuleConfiguration')),
  'super_admin.access_security.login_session_audit': lazy(() => import('./super_admin/SessionAudit')),
  'super_admin.operations.system_health_integration_alerts': lazy(() => import('./shared/Jobs')),
  // Approvals — one queue for leave, corrections and concessions.
  'institution_admin.approvals.approvals_center': lazy(() => import('./workflow/Approvals')),
  'institution_admin.approvals.approvals': lazy(() => import('./workflow/Approvals')),

  // Homework — the same screen from the teacher's and the child's side.
  'faculty.teaching.homework_classwork': lazy(() => import('./workflow/Homework')),
  'faculty.teaching.teacher_digital_diary': lazy(() => import('./workflow/Homework')),
  'student.homework.homework_assignments': lazy(() => import('./workflow/Homework')),
  'parent.academics.homework_academics': lazy(() => import('./workflow/Homework')),

  'super_admin.platform_configuration.audit_log': lazy(() => import('./super_admin/AuditLog')),

  // The vendor's back office. One screen carries the directory, provisioning,
  // the handover and the plan list, because in practice they are one job.
  'seller_admin.customers.tenant_directory': lazy(() => import('./seller/Tenants')),
  'seller_admin.customers.provision_new_school': lazy(() => import('./seller/Tenants')),
  'seller_admin.customers.suspend_reactivate': lazy(() => import('./seller/Tenants')),
  'seller_admin.customers.onboarding_progress': lazy(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.plans_pricing': lazy(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.subscription_ledger': lazy(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.seat_overage_renewals': lazy(() => import('./seller/Tenants')),

  'institution_admin.home.executive_kpis': lazy(() => import('./principal/Dashboard')),
  'institution_admin.home.needs_attention': lazy(() => import('./principal/Dashboard')),
  'institution_admin.academics.attendance_monitoring': lazy(() => import('./principal/AttendanceMonitoring')),
  'institution_admin.standard.comprehensive_attendance_report': lazy(() => import('./principal/AttendanceMonitoring')),
  'institution_admin.directory_workload.staff_allocation_workload': lazy(() => import('./principal/StaffWorkload')),
  'institution_admin.academics.timetable': lazy(() => import('./shared/Timetable')),
  'institution_admin.home.department_kpis': lazy(() => import('./hod/Department')),
  'institution_admin.directory_workload.faculty_directory': lazy(() => import('./hod/Department')),
  'institution_admin.directory_workload.faculty_allocation_workload': lazy(() => import('./hod/Department')),
  'faculty.home.todays_classes': lazy(() => import('./faculty/TodaysClasses')),
  'faculty.home.my_work': lazy(() => import('./faculty/MyWork')),

  // The NEP holistic card. One screen for the teacher recording observations
  // and the family reading them — the same card from two sides, and building
  // two would guarantee they drift.
  'faculty.marks_report_cards.nep_holistic_progress_card_hpc': lazy(() => import('./exams/HolisticCard')),
  'institution_admin.boards_accreditation.parakh_nep_credit_framework': lazy(() => import('./exams/HolisticCard')),

  /* Exam day. One screen, two halves: the office allocates halls and prints
     the invigilator's plan, a candidate reads their own ticket. Which half you
     get follows from whether you can write exams. */
  'institution_admin.examinations.hall_ticket_issue': lazy(() => import('./exams/HallTicket')),
  'student.exams_results.board_hall_ticket_download': lazy(() => import('./exams/HallTicket')),
  'student.exams_results.digital_hall_ticket_verification_qr': lazy(() => import('./exams/HallTicket')),
  'faculty.my_classes.my_classes': lazy(() => import('./faculty/TodaysClasses')),
  'faculty.attendance.take_attendance': lazy(() => import('./shared/Attendance')),
  'faculty.timetable.my_timetable': lazy(() => import('./shared/Timetable')),
  'finance.home.finance_kpis': lazy(() => import('./finance/Dashboard')),
  'finance.home.needs_attention': lazy(() => import('./finance/Dashboard')),
  'finance.collections.collect_payment': lazy(() => import('./finance/FeeCounter')),
  'finance.student_dues.student_ledger': lazy(() => import('./finance/FeeCounter')),
  'finance.collections.receipts': lazy(() => import('./finance/FeeCounter')),
  'finance.collections.partial_advance_payments': lazy(() => import('./finance/FeeCounter')),
  'finance.student_dues.defaulters_reminders': lazy(() => import('./finance/Defaulters')),
  'finance.student_dues.post_dated_cheques_pdc_registry': lazy(() => import('./finance/PDCRegister')),
  'finance.student_dues.cheque_bounce_fine_engine': lazy(() => import('./finance/PDCRegister')),
  'parent.fees.fees_payments': lazy(() => import('./portal/Fees')),
  'student.fees.fees': lazy(() => import('./portal/Fees')),
  'admissions.home.admissions_kpis': lazy(() => import('./admissions/Dashboard')),
  'admissions.home.follow_ups': lazy(() => import('./admissions/Dashboard')),
  'hr.home.hr_kpis': lazy(() => import('./hr/Dashboard')),
  'student.home.my_day': lazy(() => import('./portal/Portal')),
  'student.home.action_reminders': lazy(() => import('./portal/Portal')),
  'student.attendance.attendance': lazy(() => import('./portal/Portal')),
  'student.timetable.timetable': lazy(() => import('./shared/Timetable')),
  'student.profile.profile': lazy(() => import('./shared/Profile')),
  'parent.home.child_switcher': lazy(() => import('./portal/Portal')),
  'parent.home.child_summary': lazy(() => import('./portal/Portal')),
  'parent.home.needs_attention': lazy(() => import('./portal/Portal')),
  'parent.attendance.attendance': lazy(() => import('./portal/Portal')),
  'admissions.admissions.merit_list_generation': lazy(() => import('./admissions/Pipeline')),
  'admissions.admissions.seat_allocation_management': lazy(() => import('./admissions/Pipeline')),
  'admissions.admissions.offers_admission_decisions': lazy(() => import('./admissions/Pipeline')),
  'admissions.admissions.enrollment_handoff': lazy(() => import('./admissions/Pipeline')),
  'admissions.reports.admission_conversion_reports': lazy(() => import('./admissions/Pipeline')),
  'admissions.admissions.rte_right_to_education_quota_tracking': lazy(() => import('./admissions/Pipeline')),
  'institution_admin.admissions.admissions_overview': lazy(() => import('./admissions/Pipeline')),
  'faculty.marks_report_cards.marks_entry': lazy(() => import('./exams/Gradebook')),
  'institution_admin.examinations.exams_result_status': lazy(() => import('./exams/ReportCards')),
  'institution_admin.standard.exam_grade_analytics': lazy(() => import('./exams/ReportCards')),
  'student.exams_results.exams_grades': lazy(() => import('./portal/Results')),
  'parent.academics.results_report_cards': lazy(() => import('./portal/Results')),
  'institution_admin.students.certificates_documents': lazy(() => import('./lifecycle/Certificates')),
  'institution_admin.communication.communication': lazy(() => import('./comms/Circulars')),
  'parent.messages.communication': lazy(() => import('./comms/Circulars')),
  'student.notices_calendar.announcements_messages': lazy(() => import('./comms/Circulars')),
  'institution_admin.statutory_returns.udise_return_preparation': lazy(() => import('./compliance/UDISE')),
  'institution_admin.statutory_returns.apaar_id_register': lazy(() => import('./compliance/UDISE')),
  'institution_admin.statutory_returns.statutory_registers': lazy(() => import('./compliance/UDISE')),
  'super_admin.statutory_boards.udise_data_sync': lazy(() => import('./compliance/UDISE')),
  'super_admin.statutory_boards.apaar_id_provisioning': lazy(() => import('./compliance/UDISE')),
  'hr.payroll.payroll': lazy(() => import('./payroll/Payroll')),
  'hr.payroll.payslip_generation_email_dispatch': lazy(() => import('./payroll/Payroll')),
  'hr.payroll.salary_structure_builder': lazy(() => import('./payroll/Payroll')),

  /* --- the six workspaces added for roles that had permissions and no menu --

     Every entry below points at a screen that already exists. A vice principal
     reads the same attendance monitor the principal does and the same academic
     structure the office does; what differs is the scope resolved for them and
     the menu they arrive at. Building six parallel copies of those screens
     would have been six places for the same bug.

     Anything in these roles' catalogues without a line here renders the honest
     "not built yet" placeholder, exactly as it does for every other role. */

  // Vice Principal / Academic Coordinator — runs teaching and learning.
  'institution_admin.home.academic_kpis': lazy(() => import('./principal/Dashboard')),
  'institution_admin.academics.classes_sections': lazy(() => import('./shared/Academics')),
  'institution_admin.academics.teacher_allocation': lazy(() => import('./principal/StaffWorkload')),
  'institution_admin.examinations.exams_results': lazy(() => import('./exams/ReportCards')),
  'institution_admin.examinations.report_cards': lazy(() => import('./exams/HolisticCard')),
  'institution_admin.students.student_directory': lazy(() => import('./shared/StudentProfile')),
  'institution_admin.directory_workload.faculty_directory_workload': lazy(() => import('./principal/StaffWorkload')),
  'institution_admin.communication.circulars_announcements': lazy(() => import('./comms/Circulars')),

  // Class Teacher — one section, and the pastoral load that comes with it.
  'faculty.home.my_day': lazy(() => import('./faculty/MyWork')),
  'faculty.my_classes.my_students': lazy(() => import('./shared/Students')),
  'faculty.my_classes.student_details': lazy(() => import('./shared/StudentProfile')),
  'faculty.marks_report_cards.holistic_progress_card': lazy(() => import('./exams/HolisticCard')),
  'faculty.marks_report_cards.report_cards': lazy(() => import('./exams/ReportCards')),
  'faculty.communication.announcements': lazy(() => import('./comms/Circulars')),
  'faculty.my_profile.profile': lazy(() => import('./shared/Profile')),

  // Transport Manager, Librarian, Hostel Warden — the operations umbrella
  // split into the three jobs a larger school staffs separately.



  /* HR. The staff file and the register: employee records exist to answer
     "who works here" and "produce that document" -- the second being the one
     that lapses quietly. Both staff-attendance endpoints existed with no
     caller, which is why every dashboard's "teachers absent" read an empty
     table. */
  'hr.records.employee_master': lazy(() => import('./hr/Employees')),
  'hr.records.employee_documents': lazy(() => import('./hr/Employees')),
  'hr.records.employee_document_expiry_alerts': lazy(() => import('./hr/Employees')),
  'hr.records.staff_id_card_printing': lazy(() => import('./hr/Employees')),
  'hr.attendance.staff_attendance': lazy(() => import('./hr/StaffAttendance')),

  /* Fees: the two ways money leaves a ledger, and the two ways it arrives.
     Concessions and refunds share a screen because they are one decision from
     two ends; payments splits by mode because cash in the drawer and a cheque
     that may yet bounce are not the same collection. */
  'finance.concessions_refunds.discounts_scholarships': lazy(() => import('./finance/Concessions')),
  'finance.concessions_refunds.multi_level_concession_approvals': lazy(() => import('./finance/Concessions')),
  'finance.concessions_refunds.refunds': lazy(() => import('./finance/Concessions')),
  'finance.collections.online_payments': lazy(() => import('./finance/Payments')),
  'finance.reconciliation.reconciliation': lazy(() => import('./finance/Payments')),
  'finance.reconciliation.payment_gateway_reconciliation': lazy(() => import('./finance/Payments')),
  'finance.fee_structure.fee_head_group_setup': lazy(() => import('./setup/Wizard')),
  'finance.fee_structure.class_wise_fee_structure_configuration': lazy(() => import('./setup/Wizard')),

  /* Operations. Four screens for the school's physical side, each collapsing
     the catalogue's many entries onto the one place the work happens. */
  'institution_admin.hostel.buildings_rooms': lazy(() => import('./operations/Hostel')),
  'institution_admin.hostel.hostel_building_room_setup': lazy(() => import('./operations/Hostel')),
  'institution_admin.hostel.room_allocation': lazy(() => import('./operations/Hostel')),
  'institution_admin.hostel.room_allocation_engine': lazy(() => import('./operations/Hostel')),
  'institution_admin.hostel.roll_call': lazy(() => import('./operations/Hostel')),
  'institution_admin.hostel.hostel_roll_call_attendance': lazy(() => import('./operations/Hostel')),

  'institution_admin.stores.item_category_store_setup': lazy(() => import('./operations/Stores')),
  'institution_admin.stores.department_stock_issuance': lazy(() => import('./operations/Stores')),

  'institution_admin.infirmary.student_health_master_file': lazy(() => import('./operations/Infirmary')),
  'institution_admin.infirmary.emergency_health_alerts': lazy(() => import('./operations/Infirmary')),

  'institution_admin.transport.vehicles': lazy(() => import('./operations/Transport')),
  'institution_admin.transport.vehicle_master_registry': lazy(() => import('./operations/Transport')),
  'institution_admin.transport.routes_stops': lazy(() => import('./operations/Transport')),
  'institution_admin.transport.route_pickup_stop_mapping': lazy(() => import('./operations/Transport')),
  'institution_admin.transport.route_distance_fee_slabs': lazy(() => import('./operations/Transport')),

  /* Library. One screen answers the three questions a counter gets asked --
     do we have it, who has it, what do they owe -- so the catalogue, the
     circulation list and the overdue list are tabs rather than three menu
     entries that would each open the same data. */
  'institution_admin.library.books_copies': lazy(() => import('./operations/Library')),
  'institution_admin.library.book_cataloging_accession_register': lazy(() => import('./operations/Library')),
  'institution_admin.library.accession_register': lazy(() => import('./operations/Library')),
  'institution_admin.library.issue_return': lazy(() => import('./operations/Library')),
  'institution_admin.library.book_issue_return_terminal': lazy(() => import('./operations/Library')),
  'institution_admin.library.overdue_fine_calculation': lazy(() => import('./operations/Library')),
  'institution_admin.library.fines': lazy(() => import('./operations/Library')),
  'institution_admin.library.opac_digital_book_search': lazy(() => import('./operations/Library')),

  /* The application ladder: submitted through to enrolled. Four endpoints
     existed for this and only the list had a caller, so an application could
     be taken and never moved. Distinct from Pipeline, which is merit ranking
     and seat matrix -- a different question about the same applicants. */
  'admissions.applications.applications': lazy(() => import('./admissions/Applications')),
  'admissions.applications.applicant_documents': lazy(() => import('./admissions/Applications')),
  'admissions.applications.entrance_exam_scheduling': lazy(() => import('./admissions/Applications')),
  'admissions.applications.interview_interaction_scheduler': lazy(() => import('./admissions/Applications')),
  'admissions.admissions.provisional_offer_letters': lazy(() => import('./admissions/Applications')),
  'admissions.admissions.transfer_certificate_intake': lazy(() => import('./admissions/Applications')),
  'admissions.admissions.medium_of_instruction_selection': lazy(() => import('./admissions/Applications')),
  'admissions.admissions.child_info_id_capture': lazy(() => import('./admissions/Applications')),

  // Admissions: the enquiry queue, not the dashboard it used to point at.
  'admissions.enquiries.enquiries_leads': lazy(() => import('./admissions/Enquiries')),
  'admissions.enquiries.counselor_activity_follow_ups': lazy(() => import('./admissions/Enquiries')),

  // Leave, for the queue that decides it.
  'hr.leave.leave': lazy(() => import('./hr/Leave')),
  'faculty.my_profile.leave_self_service': lazy(() => import('./hr/Leave')),

  // One export screen, filtered server-side by what the caller may take out.
  'super_admin.platform_configuration.import_export': lazy(() => import('./shared/Exports')),
  'institution_admin.standard.reports': lazy(() => import('./shared/Exports')),
  'finance.reports.finance_reports': lazy(() => import('./shared/Exports')),

  /* Screens built against endpoints that already existed and had no caller.
     Each of these was a working handler the product could not reach: the
     corrections queue, the annual promotion, and the step that turns a fee
     structure into money owed. */
  'institution_admin.academics.attendance_corrections': lazy(() => import('./workflow/Corrections')),
  'faculty.attendance.attendance_correction': lazy(() => import('./workflow/Corrections')),
  'institution_admin.students.class_section_promotion': lazy(() => import('./lifecycle/Promotion')),
  'finance.fee_structure.demand_invoice_generation': lazy(() => import('./finance/DemandGeneration')),

  // IT Administrator — the same screens super_admin uses, bounded to one
  // school by RLS rather than by a second implementation.
  'super_admin.dashboard.system_health': lazy(() => import('./shared/Jobs')),
  'super_admin.access_security.user_directory': lazy(() => import('./super_admin/Users')),
  'super_admin.institution_setup.school_settings': lazy(() => import('./setup/Wizard')),
}

export function componentFor(key: string) {
  return FEATURE_COMPONENTS[key]
}
