import { screen } from '@/lib/screen'
import { type ComponentType, type LazyExoticComponent } from 'react'
import { financeKeys } from './finance/keys'
import { facultyCommsKeys } from './faculty/keys'
import { hrLifecycleKeys } from './hr/lifecycle-keys'
import { parentKeys } from './portal/parent-keys'
import { familyKeys } from './portal/family-keys'
import { adminAcademicsKeys } from './academics/admin-keys'
import { learningKeys } from './portal/learning-keys'
import { platformKeys } from './super_admin/platform-keys'
import { teachingKeys } from './faculty/teaching-keys'
import { boardKeys } from './exams/board-keys'
import { messagingKeys } from './super_admin/messaging-keys'
import { rollupKeys } from './analytics/rollup-keys'
import { statutoryKeys } from './compliance/statutory-keys'
import { tallyKeys } from './finance/tally-keys'
import { timetableOpsKeys } from './academics/timetable-ops-keys'
import { hodKeys } from './hod/keys'
import { adminOpsKeys } from './operations/admin-ops-keys'
import { hrGrowthKeys } from './hr/growth-keys'
import { commsKeys } from './communication/comms-keys'
import { studentLifeKeys } from './learning/student-life-keys'
import { classroomKeys } from './faculty/classroom-keys'
import { forumKeys } from './portal/forum-keys'
import { admissionsGrowthKeys } from './admissions/growth-keys'
import { mdmKeys } from './operations/mdm-keys'
import { masterTimetableKeys } from './academics/master-timetable-keys'
import { connectorsKeys } from './super_admin/connectors-keys'
import { whatsappKeys } from './super_admin/whatsapp-keys'
import { smsGatewayKeys } from './communication/sms-gateway-keys'
import { integrationsKeys } from './super_admin/integrations-keys'
import { messageRulesKeys } from './communication/message-rules-keys'
import { reportBuilderKeys } from './analytics/report-builder-keys'
import { digitalLibraryKeys } from './operations/digital-library-keys'
import { liveTrackingKeys } from './operations/live-tracking-keys'
import { geofenceKeys } from './operations/geofence-keys'
import { safetyKeys } from './operations/safety-keys'
import { childBusKeys } from './portal/child-bus-keys'
import { transportPrefsKeys } from './portal/transport-prefs-keys'
import { trackerKeys } from './super_admin/tracker-keys'

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
  'institution_admin.students.student_360': screen(() => import('./shared/StudentProfile')),
  'institution_admin.students.student_photographs': screen(() => import('./students/StudentPhotos')),
  /* The principal's own way in to setting the school up.
     The wizard carried every form a new school needs -- academic year,
     classes, sections, subjects, the school day, staff, students, grading,
     fees and exams -- and was registered only under super_admin, so the one
     person actually responsible for the school could not reach it. A school
     bought on the website therefore arrived at a dashboard of zeroes with no
     way to enter anything, which is the state a principal reported. */
  /* Setting the school up is the first thing a new principal does and it was
     filed under Academics, three sections down, next to the syllabus tracker.
     It has its own entry directly under the dashboard now; the Academics keys
     still point at the same screen, because somebody returning to change one
     step will look for it where they last saw it. */
  'institution_admin.getting_started.school_setup': screen(() => import('./setup/Wizard')),
  'super_admin.institution_setup.institutions_campuses': screen(() => import('./setup/Wizard')),
  'super_admin.institution_setup.academic_year_defaults': screen(() => import('./setup/Wizard')),
  'super_admin.platform_configuration.data_operations': screen(() => import('./setup/ImportStudents')),
  'institution_admin.students.certificates_transfers': screen(() => import('./lifecycle/Certificates')),
  'super_admin.access_security.users': screen(() => import('./super_admin/Users')),
  'super_admin.access_security.roles_permissions': screen(() => import('./super_admin/RolesPermissions')),
  /* The same screen for the school itself.

     A principal already holds access.roles.read and access.roles.write, and
     the endpoints behind this screen would have answered them all along --
     there was simply no navigation to it outside the vendor console. So a
     school could merge two whole roles onto a person, and could copy a role,
     but could never then tune the copy: "front desk, plus seeing fees, and
     nothing else" was not expressible.

     Safe to expose as it stands, and not because this screen is careful: the
     server refuses to rewrite a built-in role at all (errSystemRole), and
     refuses to grant platform.* to anyone who is not the vendor even if the
     grid asks for it. Both checks sit inside the tenant transaction, so they
     hold whatever the client sends. */
  'institution_admin.staff.roles_permissions': screen(() => import('./super_admin/RolesPermissions')),
  'super_admin.platform_configuration.module_configuration': screen(() => import('./super_admin/ModuleConfiguration')),
  'super_admin.access_security.login_session_audit': screen(() => import('./super_admin/SessionAudit')),
  'super_admin.operations.system_health_integration_alerts': screen(() => import('./shared/Jobs')),
  // Approvals — one queue for leave, corrections and concessions.
  'institution_admin.approvals.approvals': screen(() => import('./workflow/Approvals')),

  // Homework — the same screen from the teacher's and the child's side.
  'faculty.teaching.homework_classwork': screen(() => import('./workflow/Homework')),
  'student.homework.homework_assignments': screen(() => import('./workflow/Homework')),
  'parent.academics.homework_academics': screen(() => import('./workflow/Homework')),

  'super_admin.platform_configuration.audit_log': screen(() => import('./super_admin/AuditLog')),

  // The vendor's back office. One screen carries the directory, provisioning,
  // the handover and the plan list, because in practice they are one job.
  // The vendor's own first screen. Every other role opens on a dashboard;
  // this one opened on a table of schools with the business's four numbers
  // squeezed above it as a header.
  'seller_admin.home.dashboard': screen(() => import('./seller/SellerDashboard')),
  'seller_admin.schools.schools': screen(() => import('./seller/Tenants')),
  'seller_admin.schools.add_school': screen(() => import('./seller/Tenants')),
  'seller_admin.schools.access': screen(() => import('./seller/Tenants')),
  'seller_admin.schools.setup': screen(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.plans_pricing': screen(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.subscription_ledger': screen(() => import('./seller/Tenants')),
  'seller_admin.subscriptions_billing.license_capacity': screen(() => import('./seller/Tenants')),

  'institution_admin.home.dashboard': screen(() => import('./principal/Dashboard')),
  'institution_admin.academics.attendance_audit': screen(() => import('./principal/AttendanceMonitoring')),
  'institution_admin.standard.attendance_overview': screen(() => import('./principal/AttendanceMonitoring')),
  'institution_admin.directory_workload.faculty_directory': screen(() => import('./hod/Department')),
  'institution_admin.directory_workload.teacher_workload_timetable_overview': screen(() => import('./hod/Department')),
  'faculty.home.todays_classes': screen(() => import('./faculty/TodaysClasses')),
  'faculty.home.my_work': screen(() => import('./faculty/MyWork')),
  'faculty.home.my_calendar': screen(() => import('./faculty/MyCalendar')),

  // The NEP holistic card. One screen for the teacher recording observations
  // and the family reading them — the same card from two sides, and building
  // two would guarantee they drift.

  /* Syllabus, lesson plans and coverage — one loop, one screen. The chapters,
     the plans that deliver them, and the percentage that follows; three
     screens would each show a third of an answer. */
  'institution_admin.academics.curriculum_roadmap': screen(() => import('./academics/Syllabus')),
  'institution_admin.academics.lesson_plans': screen(() => import('./academics/Syllabus')),
  'institution_admin.academics.syllabus_progress': screen(() => import('./academics/Syllabus')),
  'faculty.teaching.lesson_plans_content': screen(() => import('./academics/Syllabus')),

  /* Exam day. One screen, two halves: the office allocates halls and prints
     the invigilator's plan, a candidate reads their own ticket. Which half you
     get follows from whether you can write exams. */
  'institution_admin.examinations.exams_papers': screen(() => import('./exams/Exams')),
  'institution_admin.examinations.hall_ticket_issue': screen(() => import('./exams/HallTicket')),
  'faculty.my_classes.my_classes': screen(() => import('./faculty/TodaysClasses')),
  'faculty.attendance.take_attendance': screen(() => import('./shared/Attendance')),
  'faculty.timetable.my_timetable': screen(() => import('./shared/Timetable')),
  // Where is my admission. The only parent screen that is not about a pupil:
  // at enquiry there is no student yet, so it scopes to the caller's own
  // login rather than to a selected child.
  'parent.admissions.admission_status': screen(() => import('./portal/AdmissionStatus')),
  'parent.fees.fees_payments': screen(() => import('./portal/Fees')),
  'student.fees.fees': screen(() => import('./portal/Fees')),
  'admissions.admissions.seat_allotment': screen(() => import('./admissions/Pipeline')),
  'admissions.admissions.rte_quota': screen(() => import('./admissions/Pipeline')),
  'admissions.admissions.fee_enrollment': screen(() => import('./admissions/Pipeline')),
  /* The receptionist's own workspace.
   *
   * front_office is a role a school can actually hand out — it sits in the
   * "Office staff" preset — and until it had a catalogue of its own, doing so
   * gave somebody a product with no menu in it. It is deliberately just the
   * desk: the same screen the admissions clerk uses for it, because it is the
   * same desk, and none of the admissions decisions, which are not this
   * person's to make. */
  'front_office.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'admissions.home.dashboard': screen(() => import('./admissions/Dashboard')),
  'student.home.my_day': screen(() => import('./portal/Portal')),
  'student.attendance.attendance': screen(() => import('./portal/Portal')),
  'student.timetable.timetable': screen(() => import('./shared/Timetable')),
  /* One Dashboard, where there were four entries.

     Child switcher and Child summary opened the identical screen, so the menu
     named the same page twice; Needs attention was a third click for the list
     a parent most wants on arrival. Real-Time Push Notifications was a menu
     entry for something that is not a screen — the notifications already
     arrive, on the bell and on the phone, and a page about them tells somebody
     what is already happening to them. */
  'parent.home.dashboard': screen(() => import('./portal/Portal')),
  'parent.attendance.attendance': screen(() => import('./portal/Portal')),
  'admissions.reports.admission_reports': screen(() => import('./admissions/Pipeline')),
  'institution_admin.admissions.admissions_pipeline': screen(() => import('./admissions/Pipeline')),
  'faculty.marks_report_cards.marks_entry': screen(() => import('./exams/Gradebook')),
  'institution_admin.students.academic_performance': screen(() => import('./exams/ReportCards')),
  'student.exams_results.exams_grades': screen(() => import('./portal/Results')),
  'parent.academics.results_report_cards': screen(() => import('./portal/Results')),
  /* What a school is waiting on a guardian for: a circular to sign and a trip
     to agree to. The outpass half is load-bearing — the gate will not sign a
     boarder out without a guardian's consent, so with nowhere to give it the
     pass never completes. */
  /* The front desk: the visitor register with its block list, the appointment
     diary, the telephone book and the post. Each is a paper register in most
     schools and each is asked for after something has gone wrong. */
  /* The admissions funnel: where leads came from, who is chasing them, the
     quota register an inspection reads, the waiting list, open days and the
     prospectus cash book. */
  'admissions.front_desk.front_desk': screen(() => import('./admissions/FrontDesk')),
  'front_office.front_desk.front_desk': screen(() => import('./admissions/FrontDesk')),
  'admissions.admissions.waitlist': screen(() => import('./admissions/Funnel')),
  'institution_admin.hostel.hostel_rooms': screen(() => import('./operations/Hostel')),
  'institution_admin.hostel.outpasses_mess': screen(() => import('./operations/HostelLife')),
  'institution_admin.hostel.night_study_attendance': screen(() => import('./operations/HostelNightStudy')),
  'institution_admin.hostel.room_inventory_checklists': screen(() => import('./operations/HostelRoomChecks')),
  'institution_admin.hostel.hostel_visitor_log': screen(() => import('./operations/HostelVisitors')),
  'institution_admin.hostel.boarder_laundry': screen(() => import('./operations/HostelLaundry')),
  'admissions.communication.applicant_communication': screen(() => import('./admissions/ApplicantMessages')),
  'admissions.communication.messages': screen(() => import('./comms/StaffMessages')),
  'front_office.communication.messages': screen(() => import('./comms/StaffMessages')),
  'admissions.enquiries.assign_leads': screen(() => import('./admissions/Funnel')),
  'admissions.enquiries.campus_visits': screen(() => import('./admissions/Funnel')),

  'parent.consent_permissions.permission_slips': screen(() => import('./portal/Consent')),

  'parent.messages.communication': screen(() => import('./comms/Circulars')),
  'institution_admin.statutory_returns.govt_returns': screen(() => import('./compliance/UDISE')),
  'super_admin.statutory_boards.udise_data_sync': screen(() => import('./compliance/UDISE')),
  'super_admin.statutory_boards.apaar_id_provisioning': screen(() => import('./compliance/UDISE')),

  /* --- the six workspaces added for roles that had permissions and no menu --

     Every entry below points at a screen that already exists. A vice principal
     reads the same attendance monitor the principal does and the same academic
     structure the office does; what differs is the scope resolved for them and
     the menu they arrive at. Building six parallel copies of those screens
     would have been six places for the same bug.

     Anything in these roles' catalogues without a line here renders the honest
     "not built yet" placeholder, exactly as it does for every other role. */

  // Vice Principal / Academic Coordinator — runs teaching and learning.
  /* Class Setup is the reference table, not the wizard.
   *
   * It opened the setup wizard, which resumes at whatever step is unfinished
   * — so clicking "Class Setup" on a nearly-configured school landed on
   * "Schedule an exam". Two entries opening the same wizard is exactly the
   * duplication the menu trim was meant to remove, and the wizard already has
   * its own door under Getting Started. This one shows the grades, their
   * sections and the rooms, which is what the entry says it does. */
  'institution_admin.academics.class_setup': screen(() => import('./shared/Academics')),
  /* The principal allocates, rather than only watching.

     "Teacher Assignment" opened a read-only workload table: it showed who
     teaches what and gave no way to change it, which is the one thing its own
     name promises. Only a HOD could allocate — and a HOD allocates inside
     their department, so a school with no departments defined had nobody who
     could assign a teacher to a subject at all.

     The same screen the HOD uses. It narrows itself by the caller's scope, so
     a principal gets the whole school and a HOD gets their department, from
     one component rather than two that would drift. The workload view it
     replaced is still in principal/StaffWorkload.tsx if it earns a menu entry
     of its own later; today it was standing where the work should have been. */
  'institution_admin.academics.teacher_assignment': screen(() => import('./academics/FacultyAllocation')),
  'institution_admin.examinations.exams_results': screen(() => import('./exams/ReportCards')),
  /* The principal's report card is the class teacher's report card.
     It pointed at HolisticCard — the NEP progress card, a different document
     with different columns — so the school had two screens both called
     "report cards" showing different numbers for the same child, and no way
     to tell which one a parent had been sent. */
  /* The four a principal opens weekly. Two existed under names describing
     the system rather than the question; two had no entry on this menu at
     all, so a principal could not see who was away or who was behind on fees
     without borrowing HR's or the accountant's screen. */
  'institution_admin.staff.leaves_subs': screen(() => import('./workflow/Approvals')),
  'institution_admin.fees.fee_default': screen(() => import('./finance/Defaulters')),
  'institution_admin.communication.messages': screen(() => import('./comms/StaffMessages')),
  /* The other end of the same conversation.
   *
   * A principal could write to a teacher and the teacher had nowhere to read
   * it: the notification appeared, and clicking it went to the principal's own
   * URL, which a teacher cannot open. One screen, both directions — the thread
   * is a pair of people, not a thing one of them owns. */
  'faculty.communication.messages': screen(() => import('./comms/StaffMessages')),

  /* A head of department teaches.
   *
   * They had the department's timetable, its cover and its leave, and none of
   * the work they do in front of a class — no register, no homework, no marks,
   * no lesson plan of their own, and no way to write to a parent. Every one of
   * these is the screen a teacher already uses, pointed at from a second
   * catalogue key: the same component, narrowed by the same scope, rather than
   * a second copy that would drift. */
  'hod.timetable.my_timetable': screen(() => import('./shared/Timetable')),
  'hod.attendance.take_attendance': screen(() => import('./shared/Attendance')),
  'hod.teaching.homework_classwork': screen(() => import('./workflow/Homework')),
  'hod.teaching.lesson_plans_content': screen(() => import('./academics/Syllabus')),
  'hod.marks_report_cards.marks_entry': screen(() => import('./exams/Gradebook')),
  'hod.marks_report_cards.report_cards': screen(() => import('./exams/ReportCards')),
  'hod.communication.communication': screen(() => import('./faculty/Communication')),
  'hod.communication.messages': screen(() => import('./comms/StaffMessages')),
  'institution_admin.communication.circulars': screen(() => import('./comms/Circulars')),

  // Class Teacher — one section, and the pastoral load that comes with it.
  /* One row per child across attendance, marks, homework and conduct, with
     the reason wherever something needs attention. The conduct file and the
     accommodations agreed for a child who needs them hang off the same row,
     because they are what a teacher does with the flag. */
  'faculty.my_classes.student_progress': screen(() => import('./faculty/MyClasses')),
  'faculty.my_classes.behaviour': screen(() => import('./faculty/Behaviour')),
  'faculty.my_classes.my_students': screen(() => import('./shared/Students')),
  'faculty.my_classes.student_details': screen(() => import('./shared/StudentProfile')),
  'faculty.marks_report_cards.report_cards': screen(() => import('./exams/ReportCards')),
  'faculty.my_profile.profile': screen(() => import('./shared/Profile')),

  // Transport Manager, Librarian, Hostel Warden — the operations umbrella
  // split into the three jobs a larger school staffs separately.



  /* HR. The staff file and the register: employee records exist to answer
     "who works here" and "produce that document" -- the second being the one
     that lapses quietly. Both staff-attendance endpoints existed with no
     caller, which is why every dashboard's "teachers absent" read an empty
     table. */

  /* Fees: the two ways money leaves a ledger, and the two ways it arrives.
     Concessions and refunds share a screen because they are one decision from
     two ends; payments splits by mode because cash in the drawer and a cheque
     that may yet bounce are not the same collection. */

  /* Operations. Four screens for the school's physical side, each collapsing
     the catalogue's many entries onto the one place the work happens. */

  /* The rest of a warden's evening: who is off campus, what is broken, and
     what is being served. Kept apart from the bed list because allocation is
     a termly job and these three are daily ones. */

  'institution_admin.stores.item_category_store_setup': screen(() => import('./operations/Stores')),
  'institution_admin.stores.department_stock_issuance': screen(() => import('./operations/Stores')),


  /* The transport office. Live GPS tracking, geofenced arrival alerts,
     speeding detection, fuel-tank telematics, in-bus CCTV and AIS-140/VAHAN
     registration are deliberately absent: each needs a certified device in the
     vehicle and a vendor feed, and drawing a bus on a map from no position
     data would be a lie told convincingly. */
  'transport_manager.transport.driver_attendant_profiles': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.student_route_assignment': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.transport_attendance_scans': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.vehicle_fuel_maintenance_log': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.driver_sobriety_safety_checklist': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.bus_breakdown_emergency_dispatch': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.drivers_attendants': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.student_allocation': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.route_attendance': screen(() => import('./operations/TransportOffice')),
  'transport_manager.transport.delays_exceptions': screen(() => import('./operations/TransportOffice')),

  'transport_manager.transport.vehicles': screen(() => import('./operations/Transport')),
  'transport_manager.transport.vehicle_master_registry': screen(() => import('./operations/Transport')),
  'transport_manager.transport.routes_stops': screen(() => import('./operations/Transport')),
  'transport_manager.transport.route_pickup_stop_mapping': screen(() => import('./operations/Transport')),
  'transport_manager.transport.route_distance_fee_slabs': screen(() => import('./operations/Transport')),

  /* Library. One screen answers the three questions a counter gets asked --
     do we have it, who has it, what do they owe -- so the catalogue, the
     circulation list and the overdue list are tabs rather than three menu
     entries that would each open the same data. */
  'librarian.library.books_copies': screen(() => import('./operations/Library')),
  'librarian.library.book_cataloging_accession_register': screen(() => import('./operations/Library')),
  'librarian.library.accession_register': screen(() => import('./operations/Library')),
  'librarian.library.issue_return': screen(() => import('./operations/Library')),
  'librarian.library.book_issue_return_terminal': screen(() => import('./operations/Library')),
  'institution_admin.library.fine_penalty_summary': screen(() => import('./operations/Library')),
  'librarian.library.fines': screen(() => import('./operations/Library')),
  'librarian.library.opac_digital_book_search': screen(() => import('./operations/Library')),

  /* The rest of a librarian's year, kept off the issue counter: the hold
     queue, the annual stock audit, the textbook indent and the label sheet.
     Cataloguing and issuing are daily; these are weekly, yearly and yearly. */
  'librarian.library.reservations': screen(() => import('./operations/LibraryDesk')),
  'librarian.library.book_reservation_queue': screen(() => import('./operations/LibraryDesk')),
  'institution_admin.library.annual_book_stock_verification': screen(() => import('./operations/LibraryDesk')),
  'institution_admin.library.new_session_textbook_orders': screen(() => import('./operations/LibraryDesk')),
  'librarian.library.barcode_spine_label_printing': screen(() => import('./operations/LibraryDesk')),

  /* The application ladder: submitted through to enrolled. Four endpoints
     existed for this and only the list had a caller, so an application could
     be taken and never moved. Distinct from Pipeline, which is merit ranking
     and seat matrix -- a different question about the same applicants. */
  'admissions.applications.application_forms': screen(() => import('./admissions/Applications')),
  'admissions.applications.document_verification': screen(() => import('./admissions/Applications')),

  // Admissions: the enquiry queue, not the dashboard it used to point at.
  'admissions.enquiries.enquiries': screen(() => import('./admissions/Enquiries')),
  'admissions.enquiries.follow_up_calls': screen(() => import('./admissions/Enquiries')),

  // Leave, for the queue that decides it.
  'hr.leave.leave': screen(() => import('./hr/Leave')),
  /* Statutory payroll: PF, ESI and professional tax computed from each wage,
     the returns they generate, and the three things a payroll office does
     around the payslip — withhold tax, lend against salary, and check the
     security agency billed for guards who turned up. */

  'faculty.my_profile.leave_self_service': screen(() => import('./hr/Leave')),
  /* The people who approve leave also take it.
   *
   * A principal and a head of department each had "Leaves & Subs" — everybody
   * else's requests — and no way to raise their own. The endpoint has never
   * cared who is asking; there was simply no door to it from either menu, so
   * the two people most likely to be away were the two who had to ask somebody
   * else to enter it for them. Same screen as a teacher's. */
  'institution_admin.my_profile.leave_self_service': screen(() => import('./hr/Leave')),
  'institution_admin.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'hod.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'faculty.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'hr.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'admissions.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'librarian.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'transport_manager.my_profile.my_pay': screen(() => import('./me/MyPay')),
  'faculty.exams.question_papers': screen(() => import('./exams/QuestionPapers')),
  'hod.exams.question_paper_approval': screen(() => import('./exams/QuestionPapers')),
  'institution_admin.exams.question_paper_approval': screen(() => import('./exams/QuestionPapers')),
  'hod.exams.mark_moderation': screen(() => import('./exams/MarkModeration')),
  'institution_admin.exams.mark_moderation': screen(() => import('./exams/MarkModeration')),
  'hod.my_profile.leave_self_service': screen(() => import('./hr/Leave')),
  /* Two leave queues, deliberately two doors. Your own leave is an employment
     matter that goes to HR and your head of department; a child's leave is a
     note from a parent that the class teacher has to act on before tomorrow's
     register. They were one entry, and the second was the one nobody found. */
  'faculty.my_profile.student_leave_requests': screen(() => import('./workflow/Approvals')),
  'faculty.my_profile.remarks_about_me': screen(() => import('./shared/MyRemarks')),

  // One export screen, filtered server-side by what the caller may take out.
  'super_admin.platform_configuration.import_export': screen(() => import('./shared/Exports')),
  'institution_admin.standard.reports': screen(() => import('./shared/Exports')),

  /* Screens built against endpoints that already existed and had no caller.
     Each of these was a working handler the product could not reach: the
     corrections queue, the annual promotion, and the step that turns a fee
     structure into money owed. */
  'faculty.attendance.attendance_correction': screen(() => import('./workflow/Corrections')),
  'institution_admin.students.class_promotion': screen(() => import('./lifecycle/Promotion')),

  // IT Administrator — the same screens super_admin uses, bounded to one
  // school by RLS rather than by a second implementation.
  /* The cockpit: every campus on the installation, side by side. The
     principal's dashboard is one school by design; this is the row above. */
  /* One dashboard. Seven entries opened this identical screen — campus
     cards, the summary, alerts, revenue, the funnel, the heatmap and system
     alerts — so the section listed seven doors into one room. */
  'super_admin.dashboard.dashboard': screen(() => import('./super_admin/PlatformDashboard')),
  'super_admin.dashboard.system_health': screen(() => import('./shared/Jobs')),
  'super_admin.access_security.user_directory': screen(() => import('./super_admin/Users')),
  'super_admin.institution_setup.school_settings': screen(() => import('./setup/Wizard')),

  /* Domains built in parallel hand over their own key map rather than editing
     this file, so several screens can land at once without several agents
     rewriting one object. */
  /* Vehicle tracking, all six maps. The office map, the geofenced stop
     ledger and the safety events; the parent's view of their own child's
     bus and the alert preferences behind it; and the pairing screen that
     turns a driver's phone into the tracker. */
  ...liveTrackingKeys,
  ...geofenceKeys,
  ...safetyKeys,
  ...childBusKeys,
  ...transportPrefsKeys,
  ...trackerKeys,

  'hr.onboarding_exit.staff_joinings_exits': screen(() => import('./hr/Lifecycle')),
  'hr.leave.leave_rules': screen(() => import('./hr/LeavePolicy')),
  'hr.payroll.monthly_payroll': screen(() => import('./payroll/Payroll')),
  'hr.payroll.salary_setup': screen(() => import('./payroll/SalarySetup')),
  'hr.payroll.taxes_statutory': screen(() => import('./hr/Statutory')),
  'hr.hiring_training.staff_hiring': screen(() => import('./hr/Recruitment')),
  'hr.hiring_training.staff_performance_reviews': screen(() => import('./hr/Appraisal')),
  'hr.hiring_training.staff_training_development': screen(() => import('./hr/Training')),
  'hr.home.dashboard': screen(() => import('./hr/Dashboard')),
  'hr.attendance.staff_register': screen(() => import('./hr/StaffAttendance')),
  'hr.attendance.staff_duty_roster': screen(() => import('./hr/Rostering')),
  'hr.reports.staff_analytics_reports': screen(() => import('./analytics/HRReports')),
  'hr.welfare.staff_welfare': screen(() => import('./hr/Welfare')),
  'hr.records.staff_records': screen(() => import('./hr/Employees')),
  'hr.records.service_book_qualifications': screen(() => import('./hr/ServiceRecords')),
  ...financeKeys,

  ...facultyCommsKeys,
  ...hrLifecycleKeys,
  ...parentKeys,
  ...rollupKeys,
  ...statutoryKeys,
  ...tallyKeys,
  ...hodKeys,
  ...timetableOpsKeys,
  ...adminOpsKeys,
  ...hrGrowthKeys,
  ...commsKeys,
  ...studentLifeKeys,
  ...classroomKeys,
  ...forumKeys,
  ...admissionsGrowthKeys,
  ...mdmKeys,
  ...masterTimetableKeys,
  ...connectorsKeys,
  ...whatsappKeys,
  ...smsGatewayKeys,
  ...integrationsKeys,
  ...messageRulesKeys,
  ...reportBuilderKeys,
  ...digitalLibraryKeys,
  ...familyKeys,
  ...adminAcademicsKeys,
  ...learningKeys,
  ...platformKeys,
  ...teachingKeys,
  ...boardKeys,
  ...messagingKeys,
}

export function componentFor(key: string) {
  return FEATURE_COMPONENTS[key]
}
