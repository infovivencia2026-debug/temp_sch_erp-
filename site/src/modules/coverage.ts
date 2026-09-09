import {
  CalendarRange, Users2, Goal, Database, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import type { ModuleDef, TabDef } from './registry'

/* ===========================================================================
   FEATURE COVERAGE — education

   The education matrix listed features the build did not yet expose. They live
   here rather than inside registry.ts so that file stays exactly as it was:
   nothing in it is renamed, reordered, merged or removed, and the merge below
   refuses to overwrite a tab that already exists. Placement follows where a
   registrar would look for the feature, which is occasionally not the module
   the matrix filed it under.
   =========================================================================== */

const t = (label: string, cols: string[], count = 24): TabDef => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label, cols, count,
})

/** Extra tabs appended to modules that already exist, keyed by module id. */
export const COVERAGE_TABS: Record<string, TabDef[]> = {
  /* ---------------------------------------------------------- Academics -- */
  academics: [
    t('Curriculum versions', ['code:Version', 'program:Program', 'text:Regulation@R2021,R2022,R2024,R2026', 'date:Effective from', 'status:Status@Draft,Active,Superseded'], 18),
    t('Electives', ['course:Elective', 'program:Program', 'sem:Semester', 'int:Seats', 'int:Enrolled', 'status:Status@Open,Filled,Closed'], 26),
    t('Course registration', ['person:Student', 'program:Program', 'sem:Semester', 'int:Courses', 'int:Credits', 'status:Status@Submitted,Approved,Pending advisor,Rejected'], 40),
    t('Add / drop requests', ['id:Request', 'person:Student', 'course:Course', 'text:Type@Add,Drop,Swap', 'date:Raised', 'status:Status@Pending,Approved,Rejected,Window closed'], 26),
    t('Prerequisites', ['course:Course', 'course:Requires', 'text:Rule@Must pass,Must attempt,Concurrent allowed', 'status:Enforcement@Hard block,Advisory'], 22),
    t('Substitute faculty', ['date:Date', 'course:Subject', 'person:Absent faculty', 'person:Substitute', 'room:Room', 'status:Status@Assigned,Unassigned,Cancelled'], 28),
  ],

  students: [
    t('Promotion & rollover', ['person:Student', 'program:Program', 'text:From@Year 1,Year 2,Year 3,Semester 3,Semester 5', 'text:To@Year 2,Year 3,Year 4,Semester 4,Semester 6', 'pct:Attendance', 'status:Status@Promoted,Detained,On hold,Pending review'], 44),
    t('Withdrawals', ['person:Student', 'program:Program', 'text:Reason@Relocation,Financial,Transfer to another institution,Medical,Personal', 'date:Effective', 'status:Status@Requested,Clearance pending,Completed'], 20),
    t('Student 360', ['person:Student', 'program:Program', 'sem:Semester', 'pct:Attendance', 'grade:Grade', 'money:Fee balance', 'status:Risk@Healthy,Watch,At risk'], 36),
    t('ID cards', ['person:Student', 'code:Card no', 'program:Program', 'date:Issued', 'datefuture:Valid till', 'status:Status@Active,Reprint requested,Lost,Expired'], 32),
    t('Transfer certificates', ['id:TC no', 'person:Student', 'program:Program', 'date:Applied', 'status:Status@Requested,Clearance pending,Issued,Collected'], 22),
    t('Bonafide certificates', ['id:Certificate', 'person:Student', 'text:Purpose@Passport,Bank loan,Visa,Scholarship,Internship', 'date:Applied', 'status:Status@Requested,Approved,Issued'], 26),
    t('Leave requests', ['person:Student', 'program:Program', 'text:Type@Medical,Personal,Event participation,Bereavement', 'date:From', 'int:Days', 'status:Status@Pending,Approved,Rejected'], 30),
    t('Sibling links', ['person:Student', 'person:Sibling', 'program:Program', 'text:Relation@Brother,Sister', 'status:Fee discount@Applied,Not applicable,Pending verification'], 18),
  ],

  attendance: [
    t('Period-wise', ['date:Date', 'text:Period@Period 1,Period 2,Period 3,Period 4,Period 5,Period 6', 'course:Subject', 'person:Faculty', 'room:Room', 'int:Present', 'int:Absent', 'status:Status@Submitted,Pending,Locked'], 48),
    t('Correction requests', ['id:Request', 'date:For date', 'person:Student', 'person:Raised by', 'text:Change@Absent to present,Present to absent,Mark as on-duty,Mark as medical leave', 'status:Status@Pending,Approved,Rejected'], 26),
    t('Late & early departure', ['date:Date', 'person:Student', 'time:In', 'time:Out', 'text:Type@Late arrival,Early departure', 'text:Reason@Transport delay,Medical,Family,Unexplained', 'status:Action@Noted,Parent informed,Escalated'], 34),
    t('Attendance analytics', ['program:Program', 'sem:Semester', 'pct:This month', 'pct:Last month', 'int:Below threshold', 'status:Trend@Improving,Stable,Declining'], 26),
  ],

  examinations: [
    t('Assessment schemes', ['program:Program', 'course:Course', 'text:Component@Internal 1,Internal 2,Assignment,Practical,End semester', 'int:Weight %', 'int:Max marks', 'status:Status@Draft,Approved,Locked'], 34),
    t('Internal assessment', ['course:Course', 'sem:Semester', 'person:Faculty', 'text:Component@Internal 1,Internal 2,Assignment,Quiz', 'int:Entered', 'int:Pending', 'status:Status@Open,Submitted,Verified,Locked'], 32),
    t('Question paper builder', ['id:Paper', 'course:Course', 'text:Exam@Internal 1,Internal 2,End semester,Supplementary', 'int:Questions', 'int:Total marks', 'status:Status@Draft,Reviewed,Approved,Sealed'], 24),
    t('Hall allocation', ['text:Exam@Internal 1,Internal 2,End semester', 'date:Date', 'room:Hall', 'int:Capacity', 'int:Allotted', 'status:Status@Planned,Confirmed'], 30),
    t('Seating plan', ['room:Hall', 'date:Date', 'text:Session@Forenoon,Afternoon', 'int:Students', 'int:Rows', 'status:Status@Generated,Published,Revised'], 26),
    t('Invigilators', ['date:Date', 'text:Session@Forenoon,Afternoon', 'room:Hall', 'person:Invigilator', 'dept:Department', 'status:Status@Assigned,Confirmed,Swap requested'], 34),
    t('Result publishing', ['text:Exam@End semester,Internal 2,Supplementary', 'program:Program', 'sem:Semester', 'int:Students', 'pct:Pass %', 'date:Published', 'status:Status@Withheld,Ready,Published'], 24),
    t('Supplementary exams', ['person:Student', 'course:Course', 'sem:Semester', 'text:Attempt@Attempt 2,Attempt 3,Attempt 4', 'money:Fee', 'status:Status@Registered,Fee pending,Appeared,Cleared'], 34),
    t('Backlogs', ['person:Student', 'program:Program', 'int:Backlogs', 'course:Oldest backlog', 'sem:Since', 'status:Status@Active,Cleared,Debarred'], 32),
    t('SGPA / CGPA', ['person:Student', 'program:Program', 'sem:Semester', 'int:Credits earned', 'rating:SGPA', 'rating:CGPA', 'status:Standing@Distinction,First class,Second class,Pass'], 40),
    t('Degree audit', ['person:Student', 'program:Program', 'int:Credits earned', 'int:Credits required', 'int:Pending courses', 'status:Eligibility@Eligible,Shortfall,Backlog pending,Under review'], 30),
  ],

  'report-cards': [
    t('Template designer', ['text:Template@Primary scholastic,Secondary CBSE,Senior secondary,UG semester,PG semester', 'program:Applies to', 'text:Sections@Scholastic only,Scholastic + co-scholastic,Semester grade sheet', 'status:Status@Draft,Published,Archived'], 16),
  ],

  /* ------------------------------------------------------------ Finance -- */
  finance: [
    t('Fee demand generation', ['id:Demand run', 'program:Program', 'sem:Semester', 'text:Head@Tuition,Hostel,Transport,Exam,Miscellaneous', 'int:Students', 'money:Demanded', 'status:Status@Draft,Generated,Notified'], 26),
    t('Fee receipts', ['id:Receipt', 'person:Student', 'money:Amount', 'text:Mode@Online,UPI,Cheque,Cash,NEFT,Card', 'date:Date', 'status:Status@Issued,Reprinted,Cancelled'], 44),
    t('Student ledger', ['person:Student', 'program:Program', 'money:Demanded', 'money:Paid', 'money:Balance', 'money:Advance', 'status:Standing@Clear,Partly paid,Overdue'], 40),
    t('Defaulters', ['person:Student', 'program:Program', 'money:Outstanding', 'int:Days overdue', 'int:Reminders sent', 'status:Action@Reminder sent,Parent called,Hold on hall ticket,Escalated'], 36),
    t('Advance collection', ['person:Student', 'money:Advance', 'text:Towards@Next semester,Next year,Hostel,Transport', 'date:Received', 'status:Status@Held,Adjusted,Refunded'], 22),
    t('Partial payments', ['person:Student', 'money:Instalment', 'int:Instalment no', 'datefuture:Next due', 'money:Balance', 'status:Status@On schedule,Missed,Rescheduled'], 30),
    t('Gateway reconciliation', ['id:Settlement', 'date:Date', 'text:Gateway@Razorpay,PayU,Billdesk,CCAvenue', 'int:Transactions', 'money:Gross', 'money:Settled', 'status:Status@Matched,Unmatched,Under dispute'], 28),
    t('Fee reminders', ['text:Rule@7 days before due,On due date,3 days overdue,15 days overdue', 'text:Channel@SMS,Email,WhatsApp,Push', 'int:Recipients', 'date:Last run', 'status:Status@Active,Paused'], 16),
    t('Sibling discounts', ['person:Student', 'person:Sibling', 'pct:Discount', 'money:Value', 'status:Status@Applied,Pending verification,Withdrawn'], 18),
  ],

  /* ------------------------------------------------------------- People -- */
  hr: [
    t('Faculty 360', ['person:Faculty', 'dept:Department', 'text:Designation@Professor,Associate Professor,Assistant Professor,Lecturer', 'int:Teaching hours', 'int:Publications', 'rating:Feedback', 'status:Status@Active,On leave,Notice period'], 34),
    t('Research profile', ['person:Faculty', 'dept:Department', 'int:Publications', 'int:Citations', 'int:Projects', 'code:ORCID', 'status:Scopus indexed@Yes,No,Partial'], 26),
    t('Self-service', ['person:Employee', 'text:Request@Payslip download,Leave application,Address change,Reimbursement,Document request', 'date:Raised', 'status:Status@Open,Approved,Closed'], 34),
    t('Employee ID cards', ['person:Employee', 'code:Card no', 'dept:Department', 'date:Issued', 'datefuture:Valid till', 'status:Status@Active,Reprint requested,Returned'], 26),
    t('Clearance', ['person:Employee', 'dept:Department', 'text:Pending with@Library,Accounts,IT,Hostel,HOD', 'date:Last working day', 'status:Status@In progress,Cleared,Blocked'], 18),
  ],

  /* ----------------------------------------------------- Campus services */
  transport: [
    t('Vehicles', ['code:Vehicle no', 'text:Type@Bus 52-seat,Bus 32-seat,Van,Tempo traveller', 'int:Capacity', 'datefuture:Insurance due', 'datefuture:Fitness due', 'status:Status@In service,Workshop,Idle'], 26),
    t('Attendants', ['person:Attendant', 'code:Route', 'phone:Contact', 'datefuture:Police verification', 'status:Status@Active,On leave,Exited'], 22),
    t('GPS tracking', ['code:Vehicle', 'code:Route', 'text:Last ping@On route,At stop,Depot,No signal', 'time:Updated', 'int:Delay (min)', 'status:Status@On time,Delayed,Deviation'], 28),
  ],

  hostel: [
    t('Hostel attendance', ['date:Date', 'text:Roll call@Morning,Evening,Night', 'text:Block@Block A,Block B,Block C,Block D', 'int:Present', 'int:Absent', 'int:On leave', 'status:Status@Submitted,Pending'], 30),
  ],

  library: [
    t('Renewals', ['id:Issue', 'person:Member', 'text:Title@Data Structures,Organic Chemistry,Financial Management,Thermodynamics,Constitutional Law', 'int:Renewal no', 'datefuture:New due', 'status:Status@Renewed,Refused — reserved,Refused — limit'], 26),
  ],

  assets: [
    t('Lab equipment', ['code:Asset', 'text:Equipment@Oscilloscope,Centrifuge,3D printer,Spectrometer,Lathe,Microscope', 'room:Lab', 'person:Custodian', 'datefuture:Calibration due', 'status:Status@Working,Under repair,Condemned'], 30),
  ],

  facilities: [
    t('Gate passes', ['id:Pass', 'person:Person', 'text:Type@Student outpass,Material outward,Visitor,Vehicle', 'time:Out', 'time:In', 'person:Approved by', 'status:Status@Issued,Returned,Overdue'], 34),
  ],

  health: [
    t('Emergency contacts', ['person:Student', 'person:Primary contact', 'phone:Phone', 'text:Relation@Father,Mother,Guardian,Sibling', 'text:Blood group@A+,B+,O+,AB+,A-,O-', 'status:Verified@Verified,Pending,Unreachable'], 34),
  ],

  activities: [
    t('Houses', ['text:House@Aravali,Nilgiri,Shivalik,Vindhya', 'person:House master', 'int:Members', 'int:Points', 'status:Standing@Leading,Second,Third,Fourth'], 8),
  ],

  events: [
    t('Field trips', ['text:Trip@Industrial visit,Heritage walk,Science museum,Field survey,Adventure camp', 'program:Program', 'datefuture:Date', 'int:Students', 'money:Cost per head', 'status:Status@Proposed,Consent open,Confirmed,Completed'], 20),
  ],

  helpdesk: [
    t('Grievances', ['id:Grievance', 'person:Raised by', 'text:Category@Academic,Hostel,Fees,Harassment,Facilities,Transport', 'text:Confidential@Yes,No', 'date:Raised', 'status:Status@Open,Under enquiry,Resolved,Escalated'], 28),
  ],

  /* ------------------------------------------------ Growth & compliance -- */
  placements: [
    t('Recruiters', ['company:Company', 'person:Contact', 'text:Sector@IT services,Product,Core engineering,BFSI,Consulting,Analytics', 'int:Offers last year', 'money:Median CTC', 'status:Status@Active,Prospect,Dormant'], 30),
    t('Drives', ['company:Company', 'datefuture:Drive date', 'text:Mode@On campus,Virtual,Pooled', 'int:Registered', 'int:Shortlisted', 'status:Status@Announced,Registration open,In progress,Closed'], 26),
    t('Interview schedule', ['company:Company', 'date:Date', 'time:Slot', 'text:Round@Aptitude,Technical 1,Technical 2,HR,Managerial', 'room:Venue', 'int:Candidates', 'status:Status@Scheduled,Ongoing,Completed'], 32),
    t('Internship employers', ['company:Employer', 'city:Location', 'text:Domain@Software,Manufacturing,Healthcare,Finance,Research', 'int:Openings', 'money:Stipend', 'status:MoU@Signed,Under review,Expired'], 26),
    t('Internship evaluation', ['person:Student', 'company:Employer', 'person:Mentor', 'rating:Employer rating', 'rating:Faculty rating', 'int:Credits', 'status:Status@Ongoing,Report submitted,Evaluated'], 30),
  ],

  research: [
    t('Research scholars', ['person:Scholar', 'dept:Department', 'person:Supervisor', 'text:Programme@Full time PhD,Part time PhD,MPhil,Post doctoral', 'date:Registered', 'status:Stage@Coursework,Comprehensive,Thesis,Submitted'], 28),
    t('PhD lifecycle', ['person:Scholar', 'text:Milestone@Coursework,Comprehensive viva,DC meeting 1,DC meeting 2,Synopsis,Thesis submission,Viva voce', 'datefuture:Due', 'status:Status@Completed,In progress,Overdue'], 34),
    t('Supervisor allocation', ['person:Supervisor', 'dept:Department', 'int:Scholars', 'int:Vacancy', 'status:Status@Available,At capacity,Recognition due'], 22),
  ],

  accreditation: [
    t('Calendar & deadlines', ['text:Body@NAAC,NBA,NIRF,AICTE,UGC', 'text:Activity@SSR submission,Data upload,Peer team visit,Compliance report', 'datefuture:Due', 'person:Owner', 'status:Status@On track,At risk,Overdue,Done'], 24),
    t('Evidence approvals', ['id:Evidence', 'text:Criterion@Criterion 1,Criterion 2,Criterion 3,Criterion 4,Criterion 5,Criterion 6,Criterion 7', 'dept:Submitted by', 'person:Reviewer', 'status:Status@Pending review,Approved,Sent back,Rejected'], 34),
    t('Progress', ['text:Criterion@Criterion 1,Criterion 2,Criterion 3,Criterion 4,Criterion 5,Criterion 6,Criterion 7', 'int:Evidence required', 'int:Uploaded', 'pct:Complete', 'status:Status@Complete,In progress,Not started'], 14),
    t('Document versions', ['text:Document@SSR narrative,AQAR,Programme outcomes,Faculty data sheet,Infrastructure report', 'code:Version', 'person:Edited by', 'date:Updated', 'status:Status@Current,Superseded,Draft'], 26),
  ],

  documents: [
    t('Template designer', ['text:Template@Transfer certificate,Bonafide certificate,Character certificate,Offer letter,Experience letter,Fee receipt', 'text:Type@Certificate,Letter,Receipt', 'code:Version', 'status:Status@Draft,Published,Retired'], 20),
  ],

  /* ---------------------------------------------------------- Engagement */
  workflows: [
    t('Workflow builder', ['text:Workflow@Admission approval,Fee concession,Leave approval,Purchase request,Marks correction,Certificate issue', 'int:Stages', 'text:Trigger@On submit,On threshold,Scheduled', 'status:Status@Draft,Active,Paused'], 22),
    t('Approval center', ['id:Item', 'text:Type@Fee concession,Purchase request,Leave,Marks correction,Certificate,Transfer', 'person:Requested by', 'money:Value', 'int:Age (days)', 'status:Waiting on@Me,HOD,Principal,Finance,Registrar'], 40),
  ],

  forms: [
    t('Form builder', ['text:Form@Admission enquiry,Feedback,Consent,Leave request,Event registration', 'int:Fields', 'text:Audience@Students,Parents,Staff,Public', 'int:Responses', 'status:Status@Draft,Live,Closed'], 22),
  ],

  /* -------------------------------------------------------------- System */
  security: [
    t('Single sign-on', ['text:Provider@Google Workspace,Microsoft Entra ID,Okta,SAML 2.0', 'text:Audience@Staff,Students,Parents,All', 'int:Users', 'date:Last sync', 'status:Status@Enabled,Disabled,Error'], 10),
    t('Multi-factor', ['person:User', 'text:Method@Authenticator app,SMS OTP,Email OTP,Hardware key', 'text:Enforced@Mandatory,Optional', 'date:Enrolled', 'status:Status@Active,Pending enrolment,Locked out'], 30),
    t('Data access policies', ['text:Policy@Campus scoped,Department scoped,Own records only,Finance restricted', 'text:Applies to@Faculty,HOD,Accountant,Counselor,Parent', 'text:Effect@Allow,Deny', 'status:Status@Active,Draft'], 18),
    t('Data masking', ['text:Field@Aadhaar,Bank account,Phone,Email,Medical notes,Marks', 'text:Masked for@Faculty,Front office,Transport,Vendors', 'text:Rule@Full mask,Partial mask,Hidden', 'status:Status@Active,Inactive'], 20),
  ],
}

/* ---------------------------------------------------- New modules ------- */

const mod = (
  id: string, label: string, icon: LucideIcon, group: string, tabs: TabDef[], primaryAction?: string,
): ModuleDef => ({ id, label, icon, group, tabs, primaryAction })

export const COVERAGE_MODULES: ModuleDef[] = [
  mod('academic-setup', 'Academic Setup', CalendarRange, 'Academic Operations', [
    t('Academic years', ['text:Year@2026–27,2025–26,2024–25,2023–24', 'date:Starts', 'date:Ends', 'int:Working days', 'status:Status@Current,Closed,Planned'], 8),
    t('Terms & semesters', ['text:Term@Semester 1,Semester 2,Odd semester,Even semester,Summer term', 'text:Year@2026–27,2025–26', 'date:Starts', 'date:Ends', 'status:Status@Active,Upcoming,Closed'], 14),
    t('Programs & departments', ['program:Program', 'dept:Department', 'text:Level@UG,PG,Diploma,PhD,K-12', 'int:Duration (sem)', 'int:Intake', 'status:Status@Active,Phasing out,Proposed'], 28),
    t('Classrooms & rooms', ['room:Room', 'campus:Campus', 'text:Type@Classroom,Laboratory,Seminar hall,Auditorium,Studio', 'int:Capacity', 'status:Status@Available,In use,Under maintenance'], 34),
    t('Academic calendar', ['date:Date', 'text:Event@Term begins,Internal exams,Mid-term break,Holiday,Result declaration,Convocation', 'text:Applies to@All campuses,UG,PG,K-12', 'status:Status@Confirmed,Tentative'], 30),
  ], 'Add academic year'),

  mod('parents', 'Parents & Guardians', Users2, 'Engagement', [
    t('Guardian master', ['person:Guardian', 'person:Student', 'text:Relation@Father,Mother,Legal guardian,Grandparent', 'phone:Phone', 'email:Email', 'status:Portal access@Active,Invited,Not enrolled'], 44),
    t('Portal activity', ['person:Guardian', 'date:Last login', 'int:Logins (30d)', 'text:Most viewed@Attendance,Fees,Results,Circulars,Timetable', 'status:Status@Active,Dormant,Never logged in'], 34),
    t('Communication history', ['person:Guardian', 'text:Channel@SMS,Email,WhatsApp,Push,Call', 'text:Subject@Fee reminder,Attendance alert,Result published,Circular,PTM invite', 'date:Sent', 'status:Status@Delivered,Read,Failed'], 48),
    t('Parent-teacher meetings', ['date:Date', 'program:Program', 'person:Faculty', 'time:Slot', 'int:Booked', 'int:Attended', 'status:Status@Scheduled,Open for booking,Completed'], 30),
    t('Consent & acknowledgement', ['person:Guardian', 'text:Consent@Field trip,Photo usage,Medical treatment,Data processing,Transport change', 'date:Requested', 'status:Status@Granted,Pending,Declined'], 32),
  ], 'Add guardian'),

  mod('obe', 'Outcome Based Education', Goal, 'Growth & Compliance', [
    t('Course outcomes', ['course:Course', 'code:CO', 'text:Outcome@Apply core concepts,Analyse systems,Design solutions,Evaluate trade-offs,Create artefacts', 'text:Bloom level@Remember,Understand,Apply,Analyse,Evaluate,Create', 'status:Status@Approved,Draft'], 40),
    t('Program outcomes', ['program:Program', 'code:PO', 'text:Outcome@Engineering knowledge,Problem analysis,Design development,Modern tool usage,Ethics,Lifelong learning', 'status:Status@Approved,Under revision'], 30),
    t('CO–PO mapping', ['course:Course', 'code:CO', 'code:PO', 'text:Correlation@Low (1),Medium (2),High (3)', 'status:Status@Mapped,Review pending'], 48),
    t('Attainment', ['course:Course', 'code:CO', 'pct:Direct attainment', 'pct:Indirect attainment', 'rating:Level', 'status:Status@Attained,Partly attained,Not attained'], 40),
    t('Gap analysis', ['program:Program', 'code:PO', 'pct:Target', 'pct:Achieved', 'text:Action@Curriculum revision,Additional tutorials,Assessment redesign,No action', 'status:Status@Open,In progress,Closed'], 26),
  ], 'Add outcome'),

  mod('configuration', 'Configuration', SlidersHorizontal, 'System', [
    t('Branding', ['text:Asset@Logo,Favicon,Letterhead,Email header,Portal theme', 'campus:Applies to', 'person:Updated by', 'date:Updated', 'status:Status@Published,Draft'], 14),
    t('Module configuration', ['text:Module@Hostel,Transport,Research,Placements,Cafeteria,LMS,OBE', 'text:Institution type@University,School,Both', 'status:Status@Enabled,Disabled,Enabled for some campuses'], 24),
    t('Numbering sequences', ['text:Document@Admission no,Roll no,Invoice,Receipt,Purchase order,Transfer certificate', 'code:Prefix', 'int:Next number', 'text:Reset@Yearly,Never,Monthly', 'status:Status@Active,Locked'], 20),
    t('Certificate templates', ['text:Certificate@Bonafide,Transfer,Character,Course completion,Merit,Participation', 'code:Version', 'text:Signatory@Principal,Registrar,HOD,Director', 'status:Status@Published,Draft,Retired'], 22),
  ], 'Add configuration'),

  mod('data-management', 'Data Management', Database, 'System', [
    t('Year archival', ['text:Year@2023–24,2022–23,2021–22,2020–21', 'int:Records', 'text:Scope@Students,Finance,Attendance,Examinations,All modules', 'date:Archived', 'status:Status@Archived,In progress,Retained live'], 16),
    t('Backup & restore', ['id:Backup', 'date:Taken', 'text:Type@Full,Incremental,Pre-upgrade snapshot', 'text:Location@Primary datacentre,Offsite,Object storage', 'status:Status@Verified,Pending verification,Failed'], 28),
    t('Retention policies', ['text:Data@Student records,Attendance,Financial vouchers,Applicant data,Medical records,Audit logs', 'text:Retain for@3 years,5 years,7 years,Permanent', 'text:Then@Archive,Anonymise,Delete', 'status:Status@Active,Draft'], 18),
    t('Bulk operations', ['id:Job', 'text:Operation@Bulk import,Bulk update,Bulk promotion,Bulk fee demand,Bulk credential reset', 'person:Run by', 'int:Records', 'date:Run', 'status:Status@Completed,Partially failed,Queued,Rolled back'], 30),
  ], 'Start bulk job'),
]

/* ------------------------------------------------------------ Merge ----- */

/**
 * Modules whose whole page is a bespoke view short-circuit their tabs, so a
 * feature added to one would be unreachable. Where that happens the bespoke
 * view is kept as the module's first tab — the page itself is unchanged, it
 * simply gains siblings.
 */
const HOIST_LABEL: Record<string, string> = {
  analytics: 'Overview',
  integrations: 'Connected apps',
}

/** Analytics and integration features the matrix listed, as tabs. */
export const COVERAGE_HOISTED: Record<string, TabDef[]> = {
  analytics: [
    t('Student performance', ['program:Program', 'sem:Semester', 'course:Subject', 'pct:Pass %', 'rating:Average grade', 'int:Below 40%', 'status:Trend@Improving,Stable,Declining'], 36),
    t('Academic risk', ['person:Student', 'program:Program', 'pct:Attendance', 'rating:CGPA', 'int:Backlogs', 'status:Risk@High,Medium,Low'], 40),
    t('Subject performance', ['course:Subject', 'dept:Department', 'person:Faculty', 'pct:Pass %', 'rating:Average', 'status:Flag@Strong,Watch,Concern'], 32),
    t('Faculty performance', ['person:Faculty', 'dept:Department', 'rating:Student feedback', 'pct:Result %', 'int:Teaching hours', 'status:Band@Excellent,Good,Needs support'], 30),
    t('Admission funnel', ['source:Source', 'int:Enquiries', 'int:Applications', 'int:Offers', 'int:Enrolments', 'pct:Conversion'], 20),
    t('Admission sources', ['source:Source', 'int:Leads', 'money:Cost per lead', 'pct:Conversion', 'status:Effectiveness@High,Medium,Low'], 18),
    t('Fee collection', ['program:Program', 'money:Demanded', 'money:Collected', 'pct:Collection %', 'status:Trend@Ahead,On track,Behind'], 26),
    t('Fee outstanding', ['program:Program', 'money:Outstanding', 'int:Students', 'int:Over 90 days', 'status:Severity@Critical,High,Manageable'], 26),
    t('Transport usage', ['code:Route', 'int:Capacity', 'int:Riders', 'pct:Utilisation', 'money:Cost per rider', 'status:Status@Efficient,Underused,Overloaded'], 24),
    t('Hostel occupancy', ['text:Block@Block A,Block B,Block C,Block D', 'int:Beds', 'int:Occupied', 'pct:Occupancy', 'status:Status@Full,Healthy,Underused'], 12),
    t('Library usage', ['text:Category@Engineering,Sciences,Management,Humanities,Reference,Journals', 'int:Titles', 'int:Circulations', 'pct:Turnover', 'status:Demand@High,Steady,Low'], 20),
  ],
  integrations: [
    t('Google Workspace', ['text:Service@Classroom,Drive,Calendar,Meet,Directory', 'int:Users synced', 'date:Last sync', 'status:Status@Connected,Error,Not configured'], 10),
    t('Microsoft 365', ['text:Service@Teams,OneDrive,Outlook,Entra ID', 'int:Users synced', 'date:Last sync', 'status:Status@Connected,Error,Not configured'], 10),
    t('Payment gateways', ['text:Gateway@Razorpay,PayU,Billdesk,CCAvenue', 'text:Mode@Live,Test', 'money:Settled this month', 'pct:Success rate', 'status:Status@Active,Suspended'], 10),
    t('Biometric devices', ['code:Device', 'campus:Campus', 'text:Type@Fingerprint,Face,RFID card', 'date:Last sync', 'status:Status@Online,Offline,Firmware due'], 26),
    t('SMS & WhatsApp gateways', ['text:Provider@Gupshup,Twilio,MSG91,Meta Cloud API', 'text:Channel@SMS,WhatsApp', 'int:Sent this month', 'pct:Delivery rate', 'status:Status@Active,Quota exhausted'], 10),
    t('LMS connectors', ['text:Platform@Moodle,Google Classroom,Canvas,Blackboard', 'int:Courses synced', 'date:Last sync', 'status:Status@Connected,Error,Not configured'], 10),
  ],
}

/**
 * Fold the coverage set into a module list. Existing tabs win on id, so a
 * feature the registry already carries is never replaced by one from here.
 */
export function applyCoverage(base: ModuleDef[]): ModuleDef[] {
  const merged = base.map((m) => {
    const extra = COVERAGE_TABS[m.id] ?? []
    const hoisted = COVERAGE_HOISTED[m.id] ?? []
    if (!extra.length && !hoisted.length) return m

    // A bespoke module page becomes the first tab so the additions are reachable.
    const lead: TabDef[] = m.custom && hoisted.length
      ? [{ id: 'overview', label: HOIST_LABEL[m.id] ?? 'Overview', custom: m.custom }]
      : []
    const have = new Set([...lead, ...m.tabs].map((tb) => tb.id))
    const added = [...hoisted, ...extra].filter((tb) => !have.has(tb.id))

    return {
      ...m,
      custom: lead.length ? undefined : m.custom,
      tabs: [...lead, ...m.tabs, ...added],
    }
  })

  // New modules sit beside their group rather than at the end of the sidebar.
  const out = [...merged]
  for (const m of COVERAGE_MODULES) {
    const last = out.map((x) => x.group).lastIndexOf(m.group)
    if (last === -1) out.push(m)
    else out.splice(last + 1, 0, m)
  }
  return out
}
