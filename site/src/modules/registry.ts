import {
  LayoutDashboard, UserPlus, GraduationCap, BookOpen, CalendarClock, CheckSquare,
  FileSpreadsheet, MonitorPlay, Wallet, Award, Users, Banknote, Briefcase, Gauge,
  Library, Bus, Building2, Boxes, ShoppingCart, Package, Hammer, UtensilsCrossed,
  Stethoscope, HeartHandshake, ShieldAlert, Trophy, CalendarDays, Target, Network,
  FlaskConical, BadgeCheck, FileText, MessageSquare, Baby, User, Presentation,
  Settings2, LifeBuoy, GitBranch, ClipboardList, BarChart3, Sparkles, Plug, Lock,
  Settings, Building, DoorOpen, NotebookPen, ScrollText, IdCard, Video, CalendarCheck,
  type LucideIcon,
} from 'lucide-react'
import { applyCoverage } from './coverage'

export type RoleId =
  | 'super-admin' | 'institution-admin' | 'principal' | 'dean' | 'hod' | 'faculty'
  | 'accountant' | 'hr-manager' | 'librarian' | 'transport-manager'
  | 'admission-counselor' | 'student' | 'parent'

export interface Role { id: RoleId; label: string; scope: string; modules: string[] | '*' }

export interface TabDef {
  id: string
  label: string
  /** Compact column spec — see parseCols(). */
  cols?: string[]
  count?: number
  /** Renders a bespoke view instead of the generic table. */
  custom?: string
  actions?: string[]
  description?: string
}

export interface ModuleDef {
  id: string
  label: string
  icon: LucideIcon
  group: string
  tabs: TabDef[]
  primaryAction?: string
  custom?: string
}

const t = (label: string, cols: string[], count = 24, actions?: string[]): TabDef => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label, cols, count, actions,
})
const custom = (label: string, key: string): TabDef => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, custom: key,
})

/* ============================ Module registry ============================ */
const BASE_MODULES: ModuleDef[] = [
  {
    id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview',
    custom: 'dashboard', tabs: [],
  },

  /* ------------------------------------------------------------- Academic */
  {
    id: 'admissions', label: 'Admissions CRM', icon: UserPlus, group: 'Academic Operations',
    primaryAction: 'Add lead',
    tabs: [
      custom('Overview', 'admissions-overview'),
      custom('Leads', 'admissions-pipeline'),
      t('Applications', ['id:Application No', 'person:Applicant', 'program:Program', 'status:Status@Submitted,Under Review,Shortlisted,Approved,Rejected', 'date:Submitted On', 'person:Reviewer'], 42, ['Add application', 'Import', 'Export']),
      t('Applicants', ['id:Applicant ID', 'person:Name', 'email:Email', 'phone:Phone', 'city:City', 'program:Preferred Program', 'status:Stage@New,Contacted,Test Scheduled,Interviewed,Offered,Enrolled'], 48),
      t('Entrance tests', ['code:Test Code', 'text:Test@VIT-SAT,VIT-MAT,VIT-BAT', 'datefuture:Test Date', 'room:Centre', 'int:Registered', 'int:Appeared', 'status:Status@Scheduled,In Progress,Completed'], 14),
      t('Interviews', ['id:Interview ID', 'person:Applicant', 'person:Panel Member', 'datefuture:Scheduled', 'time:Slot', 'text:Mode@On-campus,Video,Telephonic', 'status:Status@Scheduled,Completed,No Show,Rescheduled'], 26),
      t('Offers', ['id:Offer ID', 'person:Applicant', 'program:Program', 'money:Annual Fee', 'datefuture:Valid Till', 'status:Status@Draft,Sent,Accepted,Declined,Expired'], 22),
      t('Enrollments', ['id:Enrolment No', 'person:Student', 'program:Program', 'batch:Batch', 'date:Enrolled On', 'money:Fee Paid', 'status:Status@Provisional,Confirmed,Documents Pending'], 30),
      t('Documents', ['person:Applicant', 'text:Document@10th Marksheet,12th Marksheet,Transfer Certificate,Aadhaar,Photograph,Migration Certificate', 'date:Uploaded', 'status:Verification@Pending,Verified,Rejected', 'person:Verified By'], 40),
      t('Campaigns', ['text:Campaign@Monsoon Intake 2026,Merit Scholarship Drive,PG Open House,Alumni Referral', 'source:Channel', 'int:Reach', 'int:Leads', 'pct:Conversion', 'money:Spend', 'status:Status@Running,Paused,Completed'], 12),
      custom('Reports', 'admissions-reports'),
    ],
  },
  {
    id: 'students', label: 'Student Information', icon: GraduationCap, group: 'Academic Operations',
    primaryAction: 'Add student',
    tabs: [
      custom('Students', 'students-directory'),
      t('Guardians', ['person:Guardian', 'text:Relation@Father,Mother,Guardian', 'person:Student', 'phone:Phone', 'email:Email', 'text:Occupation@Business,Service,Doctor,Engineer,Teacher,Farmer'], 40),
      t('Enrollment', ['id:Enrolment No', 'person:Student', 'program:Program', 'sem:Semester', 'date:Effective From', 'status:Status@Active,On Leave,Withdrawn,Graduated'], 36),
      t('Academic records', ['person:Student', 'sem:Semester', 'course:Course', 'grade:Grade', 'int:Credits', 'pct:Score', 'status:Result@Passed,Failed,Pending'], 48),
      t('Attendance', ['person:Student', 'program:Program', 'sem:Semester', 'int:Classes Held', 'int:Attended', 'pct:Attendance', 'status:Flag@Regular,Shortage,Critical'], 44),
      t('Discipline', ['id:Case ID', 'person:Student', 'text:Category@Late Entry,Misconduct,Plagiarism,Property Damage,Ragging Complaint', 'datepast:Reported', 'status:Status@Open,Under Review,Resolved,Escalated', 'person:Handled By'], 18),
      t('Health', ['person:Student', 'text:Blood Group@A+,B+,O+,AB+,A-,O-', 'text:Condition@None,Asthma,Diabetes,Peanut Allergy,Vision Corrected', 'datepast:Last Checkup', 'status:Status@Cleared,Follow-up,Under Observation'], 30),
      t('Documents', ['person:Student', 'text:Document@Birth Certificate,Aadhaar,Marksheet,Caste Certificate,Income Certificate', 'date:Uploaded', 'status:Status@Verified,Pending,Rejected', 'datefuture:Expires'], 38),
      t('Certificates', ['id:Request ID', 'person:Student', 'text:Type@Bonafide,Transfer Certificate,Character Certificate,Course Completion,Migration', 'date:Requested', 'status:Status@Requested,In Progress,Issued,Rejected'], 24),
      t('Transfers', ['id:Transfer ID', 'person:Student', 'campus:From Campus', 'campus:To Campus', 'date:Requested', 'status:Status@Pending,Approved,Rejected'], 14),
      t('Alumni', ['person:Alumnus', 'program:Program', 'int:Batch Year', 'company:Employer', 'city:Location', 'status:Engagement@Active,Passive,Mentor,Donor'], 34),
    ],
  },
  {
    id: 'academics', label: 'Academics', icon: BookOpen, group: 'Academic Operations',
    primaryAction: 'Create program',
    tabs: [
      t('Programs', ['code:Program Code', 'program:Program', 'dept:Department', 'text:Level@UG,PG,Doctoral,Diploma', 'int:Duration (Sem)', 'int:Total Credits', 'int:Intake', 'status:Status@Active,Draft,Archived'], 30, ['Create program']),
      t('Departments', ['code:Dept Code', 'dept:Department', 'person:Head of Department', 'int:Faculty', 'int:Programs', 'int:Students', 'campus:Campus'], 18),
      t('Courses', ['code:Course Code', 'course:Course', 'dept:Department', 'int:Credits', 'text:Type@Core,Elective,Lab,Project', 'person:Coordinator', 'status:Status@Active,Archived'], 46, ['Create course', 'Copy curriculum']),
      t('Subjects', ['code:Subject Code', 'course:Subject', 'program:Program', 'sem:Semester', 'int:Credits', 'person:Faculty'], 44),
      t('Curriculum', ['program:Program', 'text:Scheme@2022 Scheme,2024 Scheme,2026 Scheme', 'sem:Semester', 'int:Courses', 'int:Credits', 'status:Status@Approved,Draft,Under Review'], 22),
      t('Batches', ['code:Batch Code', 'program:Program', 'batch:Batch', 'int:Strength', 'person:Mentor', 'status:Status@Active,Completed'], 26),
      t('Sections', ['text:Section@A,B,C,D', 'program:Program', 'sem:Semester', 'int:Capacity', 'int:Enrolled', 'room:Home Room'], 24),
      t('Semesters', ['text:Term@Odd 2026-27,Even 2026-27,Summer 2026', 'date:Starts', 'date:Ends', 'int:Working Days', 'status:Status@Planned,Ongoing,Closed'], 9),
      t('Credits', ['program:Program', 'sem:Semester', 'int:Core Credits', 'int:Elective Credits', 'int:Lab Credits', 'int:Total'], 20),
      t('Faculty allocation', ['person:Faculty', 'dept:Department', 'course:Course', 'text:Section@A,B,C,D', 'int:Hours/Week', 'status:Status@Allocated,Pending,Conflict'], 40, ['Assign faculty']),
      custom('Academic calendar', 'academic-calendar'),
      t('Lesson plans', ['course:Course', 'person:Faculty', 'int:Unit', 'text:Topic@Introduction,Core Concepts,Case Study,Revision,Assessment', 'date:Planned', 'status:Status@Planned,Delivered,Delayed'], 36),
      t('Learning outcomes', ['code:CO Code', 'course:Course', 'text:Bloom Level@Remember,Understand,Apply,Analyse,Evaluate,Create', 'pct:Attainment', 'status:Status@Met,Partially Met,Not Met'], 30),
    ],
  },
  {
    id: 'timetable', label: 'Timetable', icon: CalendarClock, group: 'Academic Operations',
    primaryAction: 'Publish timetable',
    tabs: [
      custom('Class timetable', 'timetable-grid'),
      t('Faculty timetable', ['person:Faculty', 'dept:Department', 'int:Weekly Hours', 'int:Free Slots', 'pct:Utilisation', 'status:Status@Balanced,Overloaded,Underloaded'], 28),
      t('Room timetable', ['room:Room', 'campus:Campus', 'int:Capacity', 'int:Slots Booked', 'pct:Occupancy', 'status:Status@Available,Fully Booked,Maintenance'], 26),
      t('Exam timetable', ['course:Course', 'datefuture:Exam Date', 'time:Start', 'room:Hall', 'int:Candidates', 'status:Status@Draft,Published'], 30),
      t('Resource booking', ['id:Booking ID', 'room:Resource', 'person:Booked By', 'datefuture:Date', 'time:From', 'status:Status@Confirmed,Pending,Cancelled'], 24),
      custom('Substitutions', 'substitutions'),
      t('Substitution log', ['date:Date', 'person:Absent Teacher', 'person:Substitute', 'course:Subject', 'program:Class', 'time:Period', 'status:Status@Auto-assigned,Manual,Unfilled'], 34),
    ],
  },
  {
    id: 'attendance', label: 'Attendance', icon: CheckSquare, group: 'Academic Operations',
    primaryAction: 'Bulk mark attendance',
    tabs: [
      custom('Student attendance', 'attendance-marking'),
      t('Faculty attendance', ['person:Faculty', 'dept:Department', 'date:Date', 'time:In', 'time:Out', 'status:Status@Present,Absent,On Leave,Late'], 34),
      t('Staff attendance', ['person:Staff', 'text:Role@Lab Assistant,Clerk,Security,Housekeeping,Technician', 'date:Date', 'status:Status@Present,Absent,Late,Excused'], 30),
      t('Daily attendance', ['date:Date', 'program:Program', 'int:Strength', 'int:Present', 'int:Absent', 'pct:Percentage'], 30),
      t('Subject attendance', ['course:Subject', 'person:Faculty', 'int:Sessions', 'pct:Average Attendance', 'int:Below 75%', 'status:Flag@Healthy,Watch,Critical'], 32),
      custom('Reports', 'attendance-reports'),
      t('Devices', ['code:Device ID', 'text:Type@Biometric,RFID Reader,QR Scanner,Face Recognition', 'campus:Campus', 'room:Location', 'date:Last Sync', 'status:Status@Connected,Disconnected,Maintenance'], 18),
    ],
  },
  {
    id: 'examinations', label: 'Examinations', icon: FileSpreadsheet, group: 'Academic Operations',
    primaryAction: 'Create exam',
    tabs: [
      t('Exams', ['code:Exam Code', 'text:Exam@Mid Semester,End Semester,Internal Assessment,Supplementary', 'program:Program', 'sem:Semester', 'datefuture:Starts', 'status:Status@Draft,Scheduled,Ongoing,Completed,Results Published'], 26, ['Create exam', 'Schedule exam']),
      t('Assessment plans', ['course:Course', 'text:Component@Quiz,Assignment,Mid Sem,End Sem,Lab,Viva', 'int:Weightage %', 'int:Max Marks', 'status:Status@Approved,Draft'], 34),
      t('Question banks', ['code:Bank ID', 'course:Course', 'int:Questions', 'text:Difficulty Mix@Balanced,Easy-heavy,Hard-heavy', 'person:Curated By', 'status:Status@Approved,Under Review'], 22),
      t('Hall tickets', ['person:Student', 'code:Roll No', 'text:Exam@Mid Semester,End Semester', 'room:Hall', 'int:Seat No', 'status:Status@Generated,Pending,Blocked'], 40, ['Generate hall ticket']),
      t('Exam rooms', ['room:Room', 'campus:Campus', 'int:Capacity', 'int:Allotted', 'person:Invigilator', 'status:Status@Allotted,Pending'], 26, ['Allocate rooms', 'Assign invigilators']),
      custom('Marks entry', 'marks-entry'),
      t('Gradebook', ['person:Student', 'course:Course', 'int:Internal', 'int:External', 'int:Total', 'grade:Grade', 'status:Status@Draft,Locked,Published'], 44),
      t('Results', ['person:Student', 'program:Program', 'sem:Semester', 'pct:Percentage', 'rating:CGPA', 'status:Result@Passed,Failed,Withheld'], 40, ['Publish result', 'Lock grades']),
      t('Transcripts', ['id:Request ID', 'person:Student', 'program:Program', 'date:Requested', 'status:Status@Requested,Generated,Dispatched'], 20),
      t('Revaluation', ['id:Request ID', 'person:Student', 'course:Course', 'int:Original Marks', 'int:Revised Marks', 'money:Fee', 'status:Status@Requested,In Progress,Completed,Rejected'], 18),
    ],
  },
  {
    id: 'lms', label: 'LMS / eLearning', icon: MonitorPlay, group: 'Academic Operations',
    primaryAction: 'Create course',
    tabs: [
      custom('Courses', 'lms-courses'),
      t('Lessons', ['course:Course', 'text:Lesson@Introduction,Deep Dive,Workshop,Case Study,Recap', 'int:Duration (min)', 'text:Format@Video,Reading,Slides,Interactive', 'status:Status@Published,Draft'], 40),
      t('Content', ['text:Asset@Lecture Video,Slide Deck,Reading PDF,Dataset,Code Notebook', 'course:Course', 'int:Size (MB)', 'date:Uploaded', 'status:Status@Published,Processing,Draft'], 36),
      t('Assignments', ['course:Course', 'text:Assignment@Problem Set,Lab Report,Term Paper,Group Project', 'datefuture:Due', 'int:Submissions', 'int:Pending', 'status:Status@Open,Closed,Grading'], 30),
      t('Quizzes', ['course:Course', 'text:Quiz@Weekly Quiz,Unit Test,Practice Set', 'int:Questions', 'int:Attempts', 'pct:Average Score', 'status:Status@Open,Scheduled,Closed'], 26),
      t('Discussions', ['course:Course', 'text:Thread@Doubt on Unit 3,Project grouping,Reference request,Exam pattern', 'person:Started By', 'int:Replies', 'date:Last Activity', 'status:Status@Open,Resolved'], 28),
      t('Live classes', ['course:Course', 'person:Instructor', 'datefuture:Scheduled', 'time:Start', 'text:Platform@Zoom,Teams,Google Meet', 'status:Status@Scheduled,Live,Completed,Cancelled'], 22),
      t('Progress', ['person:Student', 'course:Course', 'pct:Completion', 'int:Lessons Done', 'date:Last Access', 'status:Status@On Track,Behind,Completed'], 44),
      t('Certificates', ['person:Student', 'course:Course', 'date:Issued', 'code:Certificate No', 'status:Status@Issued,Pending'], 26),
      custom('Gamification', 'lms-gamification'),
    ],
  },


  /* ----------------------------------------------------- Front office */
  {
    id: 'front-office', label: 'Front Office', icon: DoorOpen, group: 'Campus Services',
    primaryAction: 'Log visitor',
    tabs: [
      custom('Gate pass', 'gate-pass'),
      t('Visitors', ['id:Visitor ID', 'person:Visitor', 'phone:Phone', 'text:Purpose@Admission enquiry,Fee payment,Meet class teacher,Meet principal,Collect documents,Vendor delivery,Student pickup', 'person:Meeting', 'time:In', 'time:Out', 'status:Status@Checked In,Checked Out,Expected'], 40),
      t('Walk-in enquiries', ['id:Enquiry No', 'person:Enquirer', 'person:Student Name', 'program:Seeking Admission To', 'source:Source', 'date:Date', 'person:Attended By', 'status:Status@Open,Followed Up,Converted,Lost'], 36),
      t('Phone log', ['date:Date', 'time:Time', 'person:Caller', 'phone:Number', 'text:Type@Incoming,Outgoing', 'text:Regarding@Admission,Fee,Attendance,Complaint,General', 'person:Handled By'], 34),
      t('Postal dispatch', ['id:Dispatch No', 'text:Type@Inward,Outward', 'person:From / To', 'text:Mode@Courier,Speed Post,By Hand,Registered', 'date:Date', 'status:Status@Delivered,In Transit,Received'], 28),
      t('Student checkout', ['person:Student', 'program:Class', 'text:Reason@Medical,Family emergency,Half day,Early pickup', 'person:Picked Up By', 'time:Time', 'status:Approval@Approved,Pending,Rejected'], 26),
      t('Complaints', ['id:Complaint ID', 'person:Raised By', 'text:Category@Transport,Discipline,Facilities,Staff,Academics', 'date:Date', 'text:Priority@Low,Medium,High', 'status:Status@Open,In Progress,Resolved'], 24),
      t('Lost & found', ['id:Item ID', 'text:Item@Water bottle,Tiffin box,Sweater,Textbook,ID card,Spectacles', 'text:Found At@Playground,Classroom,Bus,Canteen,Library', 'date:Found On', 'status:Status@Unclaimed,Claimed,Disposed'], 22),
    ],
  },

  /* -------------------------------------------------- Homework & diary */
  {
    id: 'homework', label: 'Homework & Diary', icon: NotebookPen, group: 'Academic Operations',
    primaryAction: 'Assign homework',
    tabs: [
      custom('Assign homework', 'homework-assign'),
      t('Homework', ['id:Homework ID', 'program:Class', 'course:Subject', 'person:Assigned By', 'date:Assigned', 'datefuture:Due', 'int:Submitted', 'int:Pending', 'status:Status@Open,Closed,Graded'], 44),
      t('Digital diary', ['date:Date', 'program:Class', 'course:Subject', 'text:Entry@Topic covered,Homework noted,Remark to parent,Circular pasted', 'person:Teacher', 'status:Parent Seen@Seen,Unseen'], 40),
      t('Submissions', ['person:Student', 'program:Class', 'course:Subject', 'date:Submitted', 'grade:Grade', 'status:Status@Submitted,Late,Not Submitted,Graded'], 48),
      t('Class work', ['date:Date', 'program:Class', 'course:Subject', 'text:Topic@Introduction,Practice problems,Revision,Activity,Test', 'person:Teacher'], 36),
      t('Remarks', ['person:Student', 'person:Teacher', 'text:Remark@Excellent participation,Homework not done,Needs improvement,Disruptive in class,Great improvement', 'date:Date', 'status:Acknowledged@Yes,Pending'], 32),
      t('Parent acknowledgement', ['person:Parent', 'person:Student', 'text:Item@Diary entry,Homework,Remark,Circular', 'date:Sent', 'status:Status@Acknowledged,Pending,No Response'], 30),
    ],
  },

  /* -------------------------------------------------------- Report cards */
  {
    id: 'report-cards', label: 'Report Cards', icon: ScrollText, group: 'Academic Operations',
    primaryAction: 'Generate report cards',
    tabs: [
      custom('Preview', 'report-card'),
      t('Scholastic', ['person:Student', 'program:Class', 'course:Subject', 'int:Periodic Test', 'int:Notebook', 'int:Subject Enrichment', 'int:Term Exam', 'int:Total', 'grade:Grade'], 48),
      t('Co-scholastic', ['person:Student', 'program:Class', 'text:Area@Work Education,Art Education,Health & Physical Education,Discipline', 'grade:Grade', 'person:Assessed By'], 40),
      t('Remarks', ['person:Student', 'program:Class', 'person:Class Teacher', 'text:Remark@Consistent performer,Shows great improvement,Needs to focus on Mathematics,Excellent all-rounder,Must improve attendance', 'sem:Term'], 34),
      t('Grade scales', ['grade:Grade', 'text:Marks Range@91-100,81-90,71-80,61-70,51-60,41-50,33-40,Below 33', 'rating:Grade Point', 'status:Result@Passed,Failed'], 8),
      t('Generation runs', ['id:Run ID', 'program:Class', 'sem:Term', 'int:Students', 'date:Generated', 'person:By', 'status:Status@Draft,Generated,Published,Locked'], 24),
      t('Publication', ['program:Class', 'sem:Term', 'date:Published', 'int:Parents Notified', 'pct:Viewed', 'status:Status@Published,Scheduled,Draft'], 22),
      t('Attendance summary', ['person:Student', 'program:Class', 'int:Working Days', 'int:Present', 'pct:Attendance', 'status:Remark@Regular,Irregular'], 40),
    ],
  },

  /* -------------------------------------------------------------- Finance */
  {
    id: 'finance', label: 'Finance', icon: Wallet, group: 'Finance & Administration',
    primaryAction: 'Create invoice',
    tabs: [
      custom('Dashboard', 'finance-dashboard'),
      t('Student fees', ['person:Student', 'program:Program', 'money:Billed', 'money:Paid', 'money:Outstanding', 'date:Due Date', 'status:Status@Paid,Partial,Overdue,Waived'], 48, ['Send reminder', 'Waive fee']),
      t('Invoices', ['id:Invoice No', 'person:Billed To', 'text:Head@Tuition Fee,Hostel Fee,Transport Fee,Exam Fee,Library Fee', 'money:Amount', 'date:Issued', 'status:Status@Paid,Unpaid,Partial,Cancelled'], 46, ['Create invoice', 'Export']),
      t('Payments', ['id:Receipt No', 'person:Paid By', 'money:Amount', 'text:Mode@UPI,Net Banking,Card,Cash,DD,NEFT', 'date:Paid On', 'status:Status@Success,Pending,Failed,Refunded'], 46, ['Record payment', 'Generate receipt']),
      t('Refunds', ['id:Refund ID', 'person:Student', 'money:Amount', 'text:Reason@Withdrawal,Overpayment,Course Change,Duplicate Payment', 'date:Requested', 'status:Status@Requested,Approved,Processed,Rejected'], 18),
      t('Discounts', ['text:Scheme@Sibling Discount,Early Bird,Staff Ward,Merit Waiver', 'person:Student', 'pct:Discount', 'money:Value', 'status:Status@Applied,Pending,Expired'], 24),
      t('Scholarships', ['text:Scholarship@Merit Excellence,Need-based Aid,Sports Quota,Girl Child,SC/ST Grant', 'person:Student', 'money:Amount', 'date:Awarded', 'status:Status@Approved,Pending,Disbursed,Rejected'], 30),
      t('Accounts', ['code:Ledger Code', 'text:Account@Tuition Income,Hostel Income,Salaries,Utilities,Maintenance,Library Assets', 'text:Type@Income,Expense,Asset,Liability', 'money:Balance', 'date:Last Entry'], 26),
      t('Expenses', ['id:Voucher No', 'text:Category@Salaries,Utilities,Maintenance,Lab Consumables,Marketing,Travel', 'vendor:Payee', 'money:Amount', 'date:Date', 'status:Status@Approved,Pending,Rejected,Paid'], 42, ['Create expense']),
      t('Budgets', ['dept:Department', 'text:Head@Capital,Operational,Research,Events', 'money:Budgeted', 'money:Actual', 'pct:Utilisation', 'status:Status@On Track,Overrun,Under-utilised'], 24),
      t('Vendors', ['vendor:Vendor', 'text:Category@Stationery,IT,Catering,Facility,Books,Furniture', 'phone:Contact', 'money:Outstanding', 'rating:Rating', 'status:Status@Active,Blocked,Under Review'], 20),
      t('Tax', ['text:Type@GST,TDS,Professional Tax', 'code:Reference', 'money:Amount', 'date:Period End', 'status:Status@Filed,Pending,Overdue'], 16),
      custom('Reports', 'finance-reports'),
    ],
  },
  {
    id: 'scholarships', label: 'Scholarships & Aid', icon: Award, group: 'Finance & Administration',
    primaryAction: 'Add scholarship',
    tabs: [
      t('Programs', ['text:Scholarship@Merit Excellence,Need-based Aid,Sports Quota,Girl Child Grant,Alumni Endowment', 'money:Corpus', 'int:Slots', 'int:Awarded', 'status:Status@Open,Closed,Draft'], 12),
      t('Applications', ['id:Application ID', 'person:Student', 'text:Scholarship@Merit Excellence,Need-based Aid,Sports Quota', 'money:Requested', 'date:Applied', 'status:Status@Submitted,Under Review,Approved,Rejected'], 34),
      t('Eligibility', ['person:Student', 'pct:Attendance', 'rating:CGPA', 'money:Family Income', 'status:Eligibility@Eligible,Not Eligible,Needs Review'], 30),
      t('Verification', ['person:Student', 'text:Document@Income Certificate,Caste Certificate,Marksheet,Bank Passbook', 'person:Verifier', 'status:Status@Verified,Pending,Rejected'], 28),
      t('Approvals', ['id:Case ID', 'person:Student', 'money:Award Amount', 'person:Approver', 'date:Decision Date', 'status:Status@Approved,Pending,Rejected'], 24),
      t('Disbursement', ['person:Student', 'money:Amount', 'text:Mode@Fee Adjustment,Bank Transfer', 'date:Disbursed', 'status:Status@Disbursed,Scheduled,On Hold'], 26),
      t('Renewals', ['person:Student', 'text:Scholarship@Merit Excellence,Need-based Aid', 'rating:Current CGPA', 'datefuture:Renewal Due', 'status:Status@Eligible,At Risk,Renewed,Lapsed'], 20),
      custom('Reports', 'generic-reports'),
    ],
  },

  /* ----------------------------------------------------------------- HR */
  {
    id: 'hr', label: 'HR & Faculty', icon: Users, group: 'People',
    primaryAction: 'Add employee',
    tabs: [
      custom('Employees', 'hr-employees'),
      t('Faculty', ['person:Faculty', 'dept:Department', 'text:Designation@Professor,Associate Professor,Assistant Professor,Lecturer', 'int:Experience (yrs)', 'int:Subjects', 'rating:Feedback', 'status:Status@Active,On Leave,Notice Period'], 40),
      t('Departments', ['dept:Department', 'person:Head', 'int:Faculty', 'int:Staff', 'money:Payroll Cost', 'campus:Campus'], 18),
      t('Attendance', ['person:Employee', 'dept:Department', 'int:Present Days', 'int:Leaves', 'pct:Attendance', 'status:Status@Regular,Irregular'], 36),
      t('Leave', ['id:Leave ID', 'person:Employee', 'text:Type@Casual,Sick,Earned,Maternity,Duty Leave', 'date:From', 'int:Days', 'status:Status@Approved,Pending,Rejected,Cancelled'], 32),
      t('Payroll', ['person:Employee', 'text:Month@Jun 2026,Jul 2026,Aug 2026', 'money:Gross', 'money:Deductions', 'money:Net Pay', 'status:Status@Paid,Processing,On Hold'], 40),
      t('Recruitment', ['id:Requisition', 'text:Position@Assistant Professor,Lab Technician,Accounts Officer,Counsellor', 'dept:Department', 'int:Applicants', 'status:Status@Open,Screening,Interviewing,Closed'], 18),
      t('Performance', ['person:Employee', 'text:Cycle@FY 2025-26,FY 2024-25', 'rating:Rating', 'text:Outcome@Exceeds,Meets,Below', 'person:Reviewer', 'status:Status@Completed,In Progress,Pending'], 34),
      t('Workload', ['person:Faculty', 'int:Teaching Hrs', 'int:Research Hrs', 'int:Admin Hrs', 'pct:Utilisation', 'status:Status@Balanced,Overloaded,Underloaded'], 32),
      t('Holidays', ['text:Holiday@Independence Day,Diwali Break,Christmas,Summer Vacation,Founders Day,Republic Day', 'date:From', 'int:Days', 'text:Applies To@All,Students Only,Staff Only', 'status:Status@Confirmed,Tentative'], 18),
      t('Training', ['text:Programme@FDP on Outcome-Based Education,NEP 2020 Workshop,Research Methodology,Digital Pedagogy', 'person:Participant', 'date:Date', 'int:Hours', 'status:Status@Completed,Enrolled,Scheduled'], 26),
      t('Documents', ['person:Employee', 'text:Document@Appointment Letter,PAN,Aadhaar,Degree Certificate,Experience Letter', 'date:Uploaded', 'status:Status@Verified,Pending,Expired'], 34),
    ],
  },
  {
    id: 'payroll', label: 'Payroll', icon: Banknote, group: 'People',
    primaryAction: 'Run payroll',
    tabs: [
      t('Salary structures', ['code:Grade', 'text:Band@Faculty A,Faculty B,Staff I,Staff II,Executive', 'money:Basic', 'money:HRA', 'money:Allowances', 'money:CTC'], 14),
      t('Earnings', ['person:Employee', 'money:Basic', 'money:HRA', 'money:DA', 'money:Special Allowance', 'money:Gross'], 36),
      t('Deductions', ['person:Employee', 'money:PF', 'money:ESI', 'money:TDS', 'money:Loan EMI', 'money:Total'], 36),
      t('Payslips', ['person:Employee', 'text:Month@Jun 2026,Jul 2026,Aug 2026', 'money:Net Pay', 'date:Generated', 'status:Status@Generated,Emailed,Pending'], 40),
      t('Payroll runs', ['id:Run ID', 'text:Month@Jun 2026,Jul 2026,Aug 2026', 'int:Employees', 'money:Total Payout', 'date:Processed', 'status:Status@Completed,Processing,Draft'], 12),
      t('Loans', ['person:Employee', 'text:Type@Personal,Vehicle,Emergency', 'money:Principal', 'money:Outstanding', 'int:EMIs Left', 'status:Status@Active,Closed'], 16),
      t('Advances', ['person:Employee', 'money:Amount', 'date:Requested', 'text:Reason@Medical,Travel,Festival', 'status:Status@Approved,Pending,Recovered'], 18),
      t('Tax', ['person:Employee', 'text:Regime@Old,New', 'money:Taxable Income', 'money:TDS Deducted', 'status:Status@Filed,Pending'], 30),
      t('Bonuses', ['person:Employee', 'text:Type@Performance,Festival,Retention', 'money:Amount', 'date:Paid', 'status:Status@Paid,Approved,Pending'], 20),
      t('Reimbursements', ['person:Employee', 'text:Category@Travel,Conference,Books,Internet', 'money:Claimed', 'money:Approved', 'status:Status@Approved,Pending,Rejected,Paid'], 24),
      custom('Reports', 'generic-reports'),
    ],
  },
  {
    id: 'recruitment', label: 'Recruitment (ATS)', icon: Briefcase, group: 'People',
    primaryAction: 'Post job opening',
    tabs: [
      t('Job openings', ['id:Job ID', 'text:Position@Assistant Professor,Associate Professor,Lab Technician,Accounts Officer,Admission Counsellor', 'dept:Department', 'campus:Campus', 'int:Vacancies', 'int:Applicants', 'status:Status@Open,On Hold,Closed'], 16),
      t('Candidates', ['person:Candidate', 'text:Position@Assistant Professor,Lab Technician,Counsellor', 'int:Experience (yrs)', 'city:Location', 'rating:Score', 'status:Stage@Applied,Screening,Interview,Offer,Hired,Rejected'], 44),
      t('Applications', ['id:Application ID', 'person:Candidate', 'text:Position@Assistant Professor,Lab Technician', 'date:Applied', 'source:Source', 'status:Status@New,Shortlisted,Rejected'], 40),
      custom('Interview pipeline', 'ats-pipeline'),
      t('Interview schedule', ['person:Candidate', 'person:Panel', 'datefuture:Date', 'time:Slot', 'text:Round@Screening,Technical,Demo Class,HR', 'status:Status@Scheduled,Completed,No Show'], 26),
      t('Scorecards', ['person:Candidate', 'person:Interviewer', 'rating:Subject Knowledge', 'rating:Communication', 'rating:Overall', 'text:Recommendation@Strong Hire,Hire,No Hire'], 28),
      t('Offers', ['person:Candidate', 'text:Position@Assistant Professor,Lab Technician', 'money:CTC', 'datefuture:Joining Date', 'status:Status@Sent,Accepted,Declined,Negotiating'], 18),
      t('Talent pool', ['person:Candidate', 'dept:Area', 'int:Experience (yrs)', 'date:Last Contact', 'status:Status@Warm,Cold,Do Not Contact'], 26),
    ],
  },
  {
    id: 'workload', label: 'Faculty Workload', icon: Gauge, group: 'People',
    tabs: [
      t('Teaching hours', ['person:Faculty', 'dept:Department', 'int:Theory Hrs', 'int:Lab Hrs', 'int:Total', 'status:Status@Balanced,Overloaded,Underloaded'], 34),
      t('Subject allocation', ['person:Faculty', 'course:Subject', 'text:Section@A,B,C,D', 'int:Hours/Week', 'status:Status@Allocated,Conflict,Pending'], 40),
      t('Research hours', ['person:Faculty', 'text:Project@AI in Education,Smart Materials,Water Treatment,FinTech Adoption', 'int:Hours/Week', 'pct:Progress'], 24),
      t('Administrative workload', ['person:Faculty', 'text:Role@Exam Coordinator,Admissions Panel,NAAC Committee,Placement Cell', 'int:Hours/Week'], 22),
      t('Extra classes', ['person:Faculty', 'course:Course', 'date:Date', 'int:Hours', 'status:Status@Approved,Pending'], 20),
      t('Availability', ['person:Faculty', 'text:Day@Monday,Tuesday,Wednesday,Thursday,Friday', 'time:From', 'time:To', 'status:Status@Available,Busy,On Leave'], 30),
      custom('Workload utilization', 'workload-chart'),
    ],
  },

  /* ------------------------------------------------------------ Campus ops */
  {
    id: 'library', label: 'Library', icon: Library, group: 'Campus Services',
    primaryAction: 'Add book',
    tabs: [
      custom('Dashboard', 'library-dashboard'),
      t('Books', ['code:Accession No', 'text:Title@Introduction to Algorithms,Operating System Concepts,Principles of Marketing,Organic Chemistry,Indian Constitution,Data Science Handbook', 'person:Author', 'text:Category@Engineering,Management,Science,Law,Fiction,Reference', 'int:Copies', 'int:Available', 'status:Status@Available,All Issued,Under Repair'], 44, ['Add book']),
      t('Catalog', ['code:ISBN', 'text:Title@Introduction to Algorithms,Operating System Concepts,Principles of Marketing,Organic Chemistry', 'text:Publisher@Pearson,McGraw Hill,Oxford,Springer,Wiley', 'int:Year', 'text:Shelf@A-1,A-2,B-3,C-1,D-4'], 40),
      t('Members', ['person:Member', 'text:Type@Student,Faculty,Staff,Alumni', 'code:Card No', 'int:Books Issued', 'money:Fines Due', 'status:Status@Active,Suspended,Expired'], 40),
      t('Issue/return', ['code:Transaction', 'person:Member', 'text:Title@Introduction to Algorithms,Operating System Concepts,Principles of Marketing', 'date:Issued', 'date:Due', 'status:Status@Issued,Returned,Overdue,Renewed'], 46, ['Issue book', 'Return book']),
      t('Reservations', ['person:Member', 'text:Title@Machine Learning,Compiler Design,Corporate Finance', 'date:Requested', 'int:Queue Position', 'status:Status@Reserved,Ready,Cancelled'], 22),
      t('Fines', ['person:Member', 'money:Fine Amount', 'int:Days Overdue', 'date:Assessed', 'status:Status@Paid,Unpaid,Waived'], 28, ['Pay fine']),
      t('Digital resources', ['text:Resource@IEEE Xplore,JSTOR,Springer Link,DELNET,NPTEL Archive', 'text:Type@Journal,eBook,Video,Database', 'int:Active Users', 'datefuture:Subscription Ends', 'status:Status@Active,Expiring,Expired'], 14),
      t('Vendors', ['vendor:Vendor', 'int:Orders', 'money:Value', 'rating:Rating', 'status:Status@Active,Blocked'], 12),
      custom('Reports', 'generic-reports'),
    ],
  },
  {
    id: 'transport', label: 'Transport', icon: Bus, group: 'Campus Services',
    primaryAction: 'Add vehicle',
    tabs: [
      custom('Vehicles', 'transport-fleet'),
      t('Routes', ['code:Route No', 'text:Route@Whitefield – Campus,Electronic City – Campus,Hebbal – Campus,Jayanagar – Campus', 'int:Stops', 'int:Distance (km)', 'int:Students', 'person:Driver', 'status:Status@Active,Suspended'], 20),
      t('Stops', ['text:Stop@Marathahalli,Silk Board,Hebbal Flyover,Banashankari,ITPL Gate', 'code:Route No', 'time:Pickup', 'time:Drop', 'int:Students'], 34),
      t('Drivers', ['person:Driver', 'code:Licence No', 'phone:Phone', 'int:Experience (yrs)', 'code:Route', 'status:Status@On Duty,Off Duty,On Leave'], 24),
      t('Students', ['person:Student', 'code:Route', 'text:Stop@Marathahalli,Silk Board,Hebbal Flyover,Banashankari', 'money:Transport Fee', 'status:Status@Active,Suspended,Paid,Overdue'], 42),
      custom('Tracking', 'transport-tracking'),
      t('Maintenance', ['code:Vehicle No', 'text:Service@Oil Change,Brake Inspection,Tyre Replacement,Full Service', 'datepast:Last Service', 'datefuture:Next Due', 'money:Cost', 'status:Status@Completed,Scheduled,Overdue'], 22),
      t('Fees', ['person:Student', 'code:Route', 'money:Annual Fee', 'money:Paid', 'money:Outstanding', 'status:Status@Paid,Partial,Overdue'], 36),
      custom('Reports', 'generic-reports'),
    ],
  },
  {
    id: 'hostel', label: 'Hostel / Housing', icon: Building2, group: 'Campus Services',
    primaryAction: 'Allocate room',
    tabs: [
      t('Hostels', ['text:Hostel@Ganga Boys Hostel,Yamuna Girls Hostel,Kaveri PG Block,Narmada Annexe', 'campus:Campus', 'int:Capacity', 'int:Occupied', 'pct:Occupancy', 'person:Warden'], 10),
      t('Buildings', ['text:Building@Block A,Block B,Block C,Annexe', 'int:Floors', 'int:Rooms', 'int:Beds', 'status:Status@Active,Under Renovation'], 12),
      t('Rooms', ['code:Room No', 'text:Hostel@Ganga Boys Hostel,Yamuna Girls Hostel,Kaveri PG Block', 'text:Type@Single,Double,Triple,Dormitory', 'int:Beds', 'int:Occupied', 'status:Status@Available,Full,Maintenance'], 44),
      t('Beds', ['code:Bed ID', 'code:Room No', 'person:Occupant', 'date:Allotted', 'status:Status@Occupied,Vacant,Reserved'], 46),
      t('Allocations', ['id:Allocation ID', 'person:Student', 'code:Room No', 'date:From', 'money:Hostel Fee', 'status:Status@Active,Vacated,Pending'], 38),
      t('Room transfers', ['person:Student', 'code:From Room', 'code:To Room', 'date:Requested', 'status:Status@Pending,Approved,Rejected'], 14),
      t('Visitors', ['person:Visitor', 'person:Meeting', 'text:Relation@Father,Mother,Sibling,Guardian', 'date:Date', 'time:In', 'status:Status@Checked In,Checked Out'], 26),
      t('Hostel fees', ['person:Student', 'money:Billed', 'money:Paid', 'money:Outstanding', 'status:Status@Paid,Partial,Overdue'], 36),
      t('Complaints', ['id:Ticket', 'person:Raised By', 'text:Category@Plumbing,Electrical,Wi-Fi,Cleanliness,Furniture', 'date:Raised', 'status:Status@Open,In Progress,Resolved'], 28),
      t('Maintenance', ['text:Task@Water Tank Cleaning,Pest Control,Painting,Generator Service', 'text:Hostel@Ganga Boys Hostel,Yamuna Girls Hostel', 'datefuture:Scheduled', 'money:Cost', 'status:Status@Scheduled,In Progress,Completed'], 18),
      t('Mess', ['text:Meal@Breakfast,Lunch,Snacks,Dinner', 'text:Menu@South Indian,North Indian,Continental,Special', 'int:Headcount', 'money:Cost/Plate', 'date:Date'], 24),
    ],
  },
  {
    id: 'inventory', label: 'Inventory & Stores', icon: Boxes, group: 'Campus Services',
    primaryAction: 'Add item',
    tabs: [
      t('Items', ['code:Item Code', 'text:Item@Whiteboard Marker,A4 Paper Ream,Lab Beaker 250ml,Projector Lamp,Ethernet Cable,Chemistry Reagent', 'text:Category@Stationery,Lab,IT,Furniture,Housekeeping', 'int:In Stock', 'int:Reorder Level', 'money:Unit Cost', 'status:Status@In Stock,Low Stock,Out of Stock'], 44),
      t('Categories', ['text:Category@Stationery,Lab,IT,Furniture,Housekeeping,Sports', 'int:Items', 'money:Stock Value', 'person:Custodian'], 10),
      t('Stock', ['code:Item Code', 'text:Warehouse@Central Store,CS Lab Store,Hostel Store,Sports Store', 'int:Quantity', 'date:Last Updated', 'status:Status@In Stock,Low Stock,Out of Stock'], 40),
      t('Warehouses', ['text:Warehouse@Central Store,CS Lab Store,Hostel Store,Sports Store', 'campus:Campus', 'person:In-charge', 'int:SKUs', 'money:Value'], 8),
      t('Purchase requests', ['id:PR No', 'dept:Requested By', 'text:Item@A4 Paper Ream,Projector Lamp,Lab Beaker 250ml', 'int:Quantity', 'money:Estimated Cost', 'status:Status@Draft,Pending,Approved,Rejected'], 30),
      t('Goods receipts', ['id:GRN No', 'vendor:Vendor', 'id:PO Ref', 'date:Received', 'int:Items', 'status:Status@Accepted,Partially Accepted,Rejected'], 26),
      t('Issue items', ['id:Issue No', 'dept:Issued To', 'text:Item@Whiteboard Marker,A4 Paper Ream,Ethernet Cable', 'int:Quantity', 'date:Issued', 'person:Issued By'], 34),
      t('Transfers', ['id:Transfer ID', 'text:From@Central Store,CS Lab Store', 'text:To@Hostel Store,Sports Store,CS Lab Store', 'int:Items', 'date:Date', 'status:Status@Completed,In Transit'], 18),
      t('Reorder levels', ['code:Item Code', 'int:Current Stock', 'int:Reorder Level', 'int:Suggested Qty', 'status:Status@Reorder Now,Healthy'], 26),
      t('Stock audit', ['id:Audit ID', 'text:Warehouse@Central Store,CS Lab Store,Hostel Store', 'date:Audit Date', 'int:Variance Items', 'person:Auditor', 'status:Status@Completed,In Progress,Planned'], 12),
    ],
  },
  {
    id: 'procurement', label: 'Procurement', icon: ShoppingCart, group: 'Campus Services',
    primaryAction: 'Raise purchase request',
    tabs: [
      t('Purchase requests', ['id:PR No', 'dept:Department', 'text:Item@Lab Equipment,Furniture,IT Hardware,Books', 'money:Estimated Value', 'date:Raised', 'status:Status@Pending,Approved,Rejected,Converted'], 30),
      t('RFQs', ['id:RFQ No', 'text:Scope@Lab Equipment Supply,Campus Furniture,Network Upgrade', 'int:Vendors Invited', 'datefuture:Closes', 'status:Status@Open,Closed,Awarded'], 16),
      t('Quotations', ['id:Quote No', 'vendor:Vendor', 'id:RFQ Ref', 'money:Quoted Value', 'int:Delivery (days)', 'status:Status@Received,Shortlisted,Rejected'], 26),
      custom('Vendor comparison', 'vendor-comparison'),
      t('Purchase orders', ['id:PO No', 'vendor:Vendor', 'money:Value', 'date:Issued', 'datefuture:Delivery Due', 'status:Status@Issued,Partially Delivered,Delivered,Cancelled'], 28),
      t('Approvals', ['id:Reference', 'text:Type@Purchase Request,Purchase Order,Contract', 'money:Value', 'person:Pending With', 'int:Level', 'status:Status@Pending,Approved,Rejected'], 22),
      t('Receipts', ['id:GRN No', 'id:PO Ref', 'vendor:Vendor', 'date:Received', 'status:Status@Accepted,Partial,Rejected'], 22),
      t('Bills', ['id:Bill No', 'vendor:Vendor', 'money:Amount', 'date:Bill Date', 'datefuture:Due', 'status:Status@Paid,Unpaid,Overdue'], 26),
      t('Contracts', ['id:Contract ID', 'vendor:Vendor', 'text:Scope@Housekeeping,Security,Catering,AMC – IT', 'money:Annual Value', 'datefuture:Expires', 'status:Status@Active,Expiring,Expired'], 14),
      t('Vendor performance', ['vendor:Vendor', 'int:Orders', 'pct:On-time Delivery', 'pct:Quality Score', 'rating:Rating', 'status:Status@Preferred,Standard,Under Review'], 16),
    ],
  },
  {
    id: 'assets', label: 'Assets', icon: Package, group: 'Campus Services',
    primaryAction: 'Register asset',
    tabs: [
      t('Asset registry', ['code:Asset Tag', 'text:Asset@Projector,Desktop PC,Lab Oscilloscope,Air Conditioner,Server Rack,Lab Bench', 'text:Category@IT,Lab,Furniture,HVAC,Vehicle', 'campus:Campus', 'money:Book Value', 'date:Purchased', 'status:Status@In Use,In Store,Under Repair,Disposed'], 46),
      t('Categories', ['text:Category@IT,Lab,Furniture,HVAC,Vehicle,Sports', 'int:Assets', 'money:Gross Value', 'pct:Depreciation Rate'], 8),
      t('Locations', ['room:Location', 'campus:Campus', 'int:Assets', 'money:Value', 'person:Custodian'], 22),
      t('Custodians', ['person:Custodian', 'dept:Department', 'int:Assets Held', 'money:Value', 'date:Last Verified'], 20),
      t('Asset assignment', ['code:Asset Tag', 'person:Assigned To', 'date:From', 'room:Location', 'status:Status@Assigned,Returned,Overdue'], 30),
      t('Depreciation', ['code:Asset Tag', 'money:Cost', 'pct:Rate', 'money:Accumulated', 'money:Net Book Value', 'int:Life (yrs)'], 34),
      t('Maintenance', ['code:Asset Tag', 'text:Type@Preventive,Corrective,Calibration', 'datepast:Last Service', 'datefuture:Next Due', 'money:Cost', 'status:Status@Completed,Scheduled,Overdue'], 26),
      t('Warranty', ['code:Asset Tag', 'vendor:Vendor', 'datefuture:Warranty Ends', 'status:Status@Active,Expiring,Expired'], 24),
      t('Disposal', ['code:Asset Tag', 'text:Reason@End of Life,Beyond Repair,Upgraded,Lost', 'money:Salvage Value', 'date:Disposed', 'status:Status@Approved,Pending'], 14),
      t('Asset audit', ['id:Audit ID', 'campus:Campus', 'date:Date', 'int:Verified', 'int:Missing', 'person:Auditor', 'status:Status@Completed,In Progress'], 12),
    ],
  },
  {
    id: 'facilities', label: 'Facilities', icon: Hammer, group: 'Campus Services',
    primaryAction: 'New maintenance request',
    tabs: [
      t('Buildings', ['text:Building@Academic Block A,Academic Block B,Library Building,Admin Block,Sports Complex', 'campus:Campus', 'int:Floors', 'int:Rooms', 'int:Year Built', 'status:Status@Active,Under Renovation'], 14),
      t('Rooms', ['room:Room', 'text:Type@Classroom,Lab,Seminar Hall,Office', 'int:Capacity', 'text:Building@Academic Block A,Academic Block B,Library Building', 'status:Status@Available,Occupied,Maintenance'], 40),
      t('Labs', ['room:Lab', 'dept:Department', 'int:Workstations', 'person:In-charge', 'status:Status@Available,In Use,Maintenance'], 22),
      t('Auditoriums', ['text:Venue@Main Auditorium,Mini Auditorium,Open Air Theatre', 'int:Capacity', 'int:Bookings This Month', 'status:Status@Available,Booked,Maintenance'], 6),
      t('Sports facilities', ['text:Facility@Cricket Ground,Basketball Court,Indoor Badminton,Gymnasium,Swimming Pool', 'campus:Campus', 'person:In-charge', 'status:Status@Available,In Use,Maintenance'], 12),
      t('Resource booking', ['id:Booking ID', 'room:Resource', 'person:Booked By', 'datefuture:Date', 'time:Slot', 'status:Status@Confirmed,Pending,Cancelled'], 28),
      t('Maintenance requests', ['id:Ticket', 'room:Location', 'text:Issue@AC Not Working,Projector Fault,Leakage,Broken Furniture,Power Outage', 'text:Priority@Low,Medium,High,Critical', 'date:Raised', 'status:Status@Open,In Progress,Resolved'], 32),
      t('Utilities', ['text:Utility@Electricity,Water,Internet,Diesel', 'campus:Campus', 'int:Units', 'money:Monthly Cost', 'text:Month@Jun 2026,Jul 2026,Aug 2026'], 20),
      t('Occupancy', ['text:Building@Academic Block A,Academic Block B,Library Building', 'int:Capacity', 'int:Current', 'pct:Occupancy'], 14),
      t('Inspection', ['id:Inspection ID', 'text:Area@Fire Safety,Electrical,Sanitation,Structural', 'date:Date', 'person:Inspector', 'status:Status@Cleared,Observations,Failed'], 16),
      t('CCTV cameras', ['code:Camera ID', 'room:Location', 'campus:Campus', 'text:Type@Dome,Bullet,PTZ', 'int:Retention (days)', 'date:Last Heartbeat', 'status:Status@Online,Offline,Recording,Maintenance'], 28),
    ],
  },
  {
    id: 'cafeteria', label: 'Cafeteria / Mess', icon: UtensilsCrossed, group: 'Campus Services',
    primaryAction: 'Publish menu',
    tabs: [
      t('Menus', ['date:Date', 'text:Meal@Breakfast,Lunch,Snacks,Dinner', 'text:Menu@Idli & Sambar,Veg Thali,Chole Bhature,Fried Rice,Paneer Curry', 'money:Price', 'status:Status@Published,Draft'], 28),
      t('Meal plans', ['text:Plan@Full Board,Lunch Only,Weekday Plan,Weekend Plan', 'money:Monthly Price', 'int:Subscribers', 'status:Status@Active,Inactive'], 8),
      t('Orders', ['id:Order ID', 'person:Customer', 'text:Item@Veg Thali,Sandwich,Filter Coffee,Masala Dosa', 'money:Amount', 'time:Time', 'status:Status@Delivered,Preparing,Cancelled'], 40),
      t('Token system', ['code:Token', 'person:Issued To', 'text:Meal@Breakfast,Lunch,Snacks,Dinner', 'date:Date', 'status:Status@Redeemed,Issued,Expired'], 34),
      t('Student wallet', ['person:Student', 'money:Balance', 'money:Spent This Month', 'date:Last Recharge', 'status:Status@Active,Low Balance,Blocked'], 36),
      t('Staff wallet', ['person:Employee', 'money:Balance', 'money:Spent This Month', 'status:Status@Active,Low Balance'], 24),
      t('Inventory', ['text:Item@Rice,Wheat Flour,Cooking Oil,Vegetables,Milk,Spices', 'int:Stock (kg)', 'int:Reorder Level', 'money:Value', 'status:Status@In Stock,Low Stock'], 20),
      t('Vendors', ['vendor:Vendor', 'text:Supplies@Groceries,Dairy,Vegetables,Bakery', 'money:Monthly Value', 'rating:Rating', 'status:Status@Active,Under Review'], 10),
      t('Daily sales', ['date:Date', 'int:Orders', 'money:Revenue', 'money:Cost', 'pct:Margin'], 30),
      t('Meal attendance', ['date:Date', 'text:Meal@Breakfast,Lunch,Snacks,Dinner', 'int:Expected', 'int:Actual', 'pct:Turnout'], 28),
    ],
  },

  /* --------------------------------------------------------- Student life */
  {
    id: 'health', label: 'Health / Clinic', icon: Stethoscope, group: 'Student Life',
    primaryAction: 'Record visit',
    tabs: [
      t('Medical profiles', ['person:Student', 'text:Blood Group@A+,B+,O+,AB+,A-,O-', 'int:Height (cm)', 'int:Weight (kg)', 'date:Last Checkup', 'status:Status@Cleared,Follow-up'], 40),
      t('Allergies', ['person:Student', 'text:Allergy@Peanuts,Dust,Penicillin,Lactose,Pollen', 'text:Severity@Mild,Moderate,Severe', 'text:Action@Antihistamine,EpiPen,Avoid Exposure'], 24),
      t('Blood groups', ['text:Blood Group@A+,B+,O+,AB+,A-,O-,B-,AB-', 'int:Students', 'int:Donors Registered'], 8),
      t('Medical visits', ['id:Visit ID', 'person:Patient', 'text:Complaint@Fever,Headache,Injury,Stomach Ache,Allergy', 'date:Date', 'person:Attended By', 'status:Status@Closed,Referred,Under Observation'], 34),
      t('Medicines', ['text:Medicine@Paracetamol,Cetirizine,ORS Sachet,Antiseptic,Bandage', 'int:Stock', 'datefuture:Expiry', 'status:Status@In Stock,Low Stock,Expiring'], 20),
      t('Vaccination', ['person:Student', 'text:Vaccine@Hepatitis B,Tetanus,Influenza,MMR', 'date:Administered', 'status:Status@Completed,Due,Overdue'], 30),
      t('Incidents', ['id:Incident ID', 'person:Involved', 'text:Type@Sports Injury,Lab Accident,Fainting,Road Accident', 'date:Date', 'status:Status@Resolved,Referred,Under Observation'], 16),
      t('Medical certificates', ['person:Student', 'text:Purpose@Leave,Exam Exemption,Sports Fitness', 'date:Issued', 'person:Issued By', 'status:Status@Issued,Pending'], 20),
      t('Health alerts', ['text:Alert@Seasonal Flu Advisory,Dengue Prevention,Heat Wave Advisory', 'campus:Campus', 'date:Issued', 'text:Severity@Low,Medium,High'], 8),
    ],
  },
  {
    id: 'counseling', label: 'Counseling & Wellbeing', icon: HeartHandshake, group: 'Student Life',
    primaryAction: 'New session',
    tabs: [
      t('Requests', ['id:Request ID', 'person:Student', 'text:Concern@Academic Stress,Career Guidance,Personal,Peer Conflict,Homesickness', 'date:Raised', 'text:Priority@Low,Medium,High', 'status:Status@New,Assigned,Closed'], 26),
      custom('Counselor calendar', 'counselor-calendar'),
      t('Sessions', ['id:Session ID', 'person:Student', 'person:Counsellor', 'date:Date', 'int:Duration (min)', 'status:Status@Completed,Scheduled,No Show'], 30),
      t('Student notes', ['person:Student', 'person:Counsellor', 'date:Date', 'text:Summary@Progress noted,Needs follow-up,Referred to specialist,Stable'], 24),
      t('Follow-ups', ['person:Student', 'datefuture:Due', 'person:Owner', 'status:Status@Pending,Completed,Overdue'], 20),
      t('Risk flags', ['person:Student', 'text:Indicator@Attendance Drop,Grade Decline,Isolation Reported,Fee Default', 'text:Risk@Low,Medium,High', 'date:Flagged', 'status:Status@Monitoring,Escalated,Cleared'], 22),
      t('Referral records', ['person:Student', 'text:Referred To@External Psychologist,Medical Officer,Academic Mentor', 'date:Date', 'status:Status@Completed,Pending'], 14),
      t('Wellbeing surveys', ['text:Survey@Semester Wellbeing Pulse,Exam Stress Check,Hostel Life Survey', 'int:Responses', 'pct:Participation', 'rating:Avg Score', 'status:Status@Open,Closed'], 8),
    ],
  },
  {
    id: 'discipline', label: 'Discipline', icon: ShieldAlert, group: 'Student Life',
    primaryAction: 'Log incident',
    tabs: [
      t('Incidents', ['id:Incident ID', 'person:Student', 'text:Category@Late Entry,Misconduct,Plagiarism,Property Damage,Ragging', 'date:Date', 'text:Severity@Minor,Moderate,Severe', 'status:Status@Open,Under Review,Resolved'], 28),
      t('Complaints', ['id:Complaint ID', 'person:Complainant', 'person:Against', 'date:Filed', 'status:Status@Open,Investigating,Closed'], 20),
      t('Warnings', ['person:Student', 'text:Level@Verbal,Written,Final', 'date:Issued', 'person:Issued By', 'status:Status@Acknowledged,Pending'], 22),
      t('Detention', ['person:Student', 'date:Date', 'int:Hours', 'person:Supervisor', 'status:Status@Completed,Scheduled,Missed'], 16),
      t('Suspensions', ['person:Student', 'date:From', 'int:Days', 'text:Reason@Misconduct,Ragging,Repeated Violations', 'status:Status@Active,Completed,Revoked'], 10),
      t('Actions', ['id:Case ID', 'text:Action@Counselling,Fine,Community Service,Parent Meeting', 'person:Student', 'date:Date', 'status:Status@Completed,Pending'], 24),
      t('Parent acknowledgement', ['person:Student', 'person:Parent', 'date:Notified', 'status:Status@Acknowledged,Pending,No Response'], 20),
      t('Behaviour points', ['person:Student', 'int:Positive Points', 'int:Negative Points', 'int:Net', 'status:Standing@Good,Watch,At Risk'], 34),
      custom('Incident analytics', 'discipline-analytics'),
    ],
  },
  {
    id: 'activities', label: 'Sports & Clubs', icon: Trophy, group: 'Student Life',
    primaryAction: 'Create club',
    tabs: [
      t('Clubs', ['text:Club@Robotics Club,Debate Society,Photography Club,Coding Club,Music Club,Eco Club', 'person:Faculty Advisor', 'int:Members', 'campus:Campus', 'status:Status@Active,Inactive'], 14),
      t('Teams', ['text:Team@Cricket XI,Basketball Team,Athletics Squad,Chess Team', 'person:Captain', 'int:Members', 'status:Status@Active,Season Break'], 10),
      t('Coaches', ['person:Coach', 'text:Sport@Cricket,Basketball,Athletics,Badminton,Swimming', 'int:Experience (yrs)', 'status:Status@Active,On Contract'], 10),
      t('Members', ['person:Student', 'text:Club@Robotics Club,Debate Society,Coding Club,Music Club', 'date:Joined', 'int:Activity Points', 'status:Status@Active,Inactive'], 40),
      t('Events', ['text:Event@Tech Fest,Sports Meet,Cultural Night,Hackathon,Inter-college Debate', 'datefuture:Date', 'room:Venue', 'int:Registrations', 'status:Status@Upcoming,Ongoing,Completed'], 18),
      t('Competitions', ['text:Competition@Inter-college Cricket,State Robotics Challenge,National Debate', 'datefuture:Date', 'int:Participants', 'status:Status@Registered,Ongoing,Completed'], 14),
      t('Achievements', ['person:Student', 'text:Achievement@Gold Medal,Runner-up,Best Speaker,Hackathon Winner', 'text:Level@Inter-college,State,National', 'date:Date'], 22),
      t('Attendance', ['person:Student', 'text:Club@Robotics Club,Coding Club,Music Club', 'int:Sessions', 'pct:Attendance'], 30),
      t('Certificates', ['person:Student', 'text:Certificate@Participation,Winner,Merit', 'date:Issued', 'status:Status@Issued,Pending'], 24),
    ],
  },
  {
    id: 'events', label: 'Events', icon: CalendarDays, group: 'Student Life',
    primaryAction: 'Create event',
    tabs: [
      t('Academic events', ['text:Event@Convocation 2026,Orientation Week,Guest Lecture Series,Industry Talk', 'datefuture:Date', 'room:Venue', 'int:Expected', 'status:Status@Upcoming,Completed'], 14),
      t('Campus events', ['text:Event@Founders Day,Cultural Fest,Sports Meet,Alumni Meet', 'datefuture:Date', 'campus:Campus', 'int:Registrations', 'status:Status@Upcoming,Ongoing,Completed'], 14),
      t('Workshops', ['text:Workshop@AI Bootcamp,3D Printing,Financial Literacy,Design Thinking', 'person:Facilitator', 'datefuture:Date', 'int:Seats', 'int:Filled', 'status:Status@Open,Full,Completed'], 16),
      t('Seminars', ['text:Seminar@Research Methodology,Startup Ecosystem,Climate Action', 'person:Speaker', 'datefuture:Date', 'int:Attendees', 'status:Status@Upcoming,Completed'], 14),
      t('Conferences', ['text:Conference@ICACT 2026,National Management Summit,Bio-Innovation Meet', 'datefuture:Date', 'int:Papers', 'int:Delegates', 'status:Status@Planned,Open,Completed'], 8),
      t('Registrations', ['person:Participant', 'text:Event@Tech Fest,AI Bootcamp,Alumni Meet,Convocation 2026', 'date:Registered', 'money:Fee', 'status:Status@Confirmed,Waitlist,Cancelled'], 40),
      t('Invitations', ['person:Invitee', 'text:Event@Convocation 2026,Founders Day,Industry Talk', 'date:Sent', 'status:Status@Accepted,Pending,Declined'], 26),
      t('Parent-teacher meetings', ['id:Slot ID', 'person:Parent', 'person:Student', 'person:Teacher', 'datefuture:Date', 'time:Slot', 'status:Status@Booked,Available,Completed,No Show'], 40),
      t('Venues', ['room:Venue', 'int:Capacity', 'campus:Campus', 'status:Status@Available,Booked,Maintenance'], 12),
      t('Attendance', ['text:Event@Tech Fest,AI Bootcamp,Alumni Meet', 'int:Registered', 'int:Attended', 'pct:Turnout'], 16),
      t('Certificates', ['person:Participant', 'text:Event@AI Bootcamp,Design Thinking,Tech Fest', 'date:Issued', 'status:Status@Issued,Pending'], 24),
    ],
  },

  /* -------------------------------------------------- Growth & compliance */
  {
    id: 'placements', label: 'Placements', icon: Target, group: 'Growth & Compliance',
    primaryAction: 'Add company',
    tabs: [
      t('Companies', ['company:Company', 'text:Sector@IT Services,Product,BFSI,Manufacturing,Consulting', 'person:HR Contact', 'int:Offers Made', 'money:Avg Package', 'status:Status@Active,Prospect,Inactive'], 20),
      t('Job opportunities', ['id:Drive ID', 'company:Company', 'text:Role@Software Engineer,Analyst,Trainee Engineer,Consultant', 'money:CTC', 'datefuture:Drive Date', 'int:Applicants', 'status:Status@Open,Closed,In Progress'], 26),
      t('Internships', ['company:Company', 'text:Role@Summer Intern,Research Intern,Marketing Intern', 'int:Duration (weeks)', 'money:Stipend', 'int:Slots', 'status:Status@Open,Closed'], 20),
      t('Student eligibility', ['person:Student', 'program:Program', 'rating:CGPA', 'int:Backlogs', 'pct:Attendance', 'status:Eligibility@Eligible,Not Eligible,Conditional'], 44),
      t('Applications', ['person:Student', 'company:Company', 'text:Role@Software Engineer,Analyst,Trainee Engineer', 'date:Applied', 'status:Status@Applied,Shortlisted,Rejected,Offered'], 46),
      t('Interview rounds', ['person:Student', 'company:Company', 'text:Round@Aptitude,Technical 1,Technical 2,HR', 'datefuture:Date', 'status:Status@Cleared,Rejected,Scheduled'], 40),
      t('Offers', ['person:Student', 'company:Company', 'money:CTC', 'date:Offer Date', 'status:Status@Accepted,Declined,Pending'], 32),
      t('Placement status', ['person:Student', 'program:Program', 'int:Offers', 'money:Highest Package', 'status:Status@Placed,Unplaced,Opted Out,Higher Studies'], 44),
      custom('Placement analytics', 'placement-analytics'),
    ],
  },
  {
    id: 'alumni', label: 'Alumni', icon: Network, group: 'Growth & Compliance',
    primaryAction: 'Add alumnus',
    tabs: [
      t('Directory', ['person:Alumnus', 'program:Program', 'int:Batch Year', 'company:Employer', 'city:Location', 'status:Status@Active,Passive'], 44),
      t('Employment', ['person:Alumnus', 'company:Company', 'text:Designation@Engineer,Senior Engineer,Manager,Founder,Consultant', 'int:Years', 'money:Package'], 36),
      t('Higher education', ['person:Alumnus', 'text:Institution@IIM Bangalore,IIT Delhi,Stanford,NUS Singapore,Oxford', 'text:Programme@MBA,MS,PhD', 'int:Year'], 22),
      t('Events', ['text:Event@Alumni Homecoming,Batch Reunion 2016,Mentor Meet', 'datefuture:Date', 'int:Registered', 'status:Status@Upcoming,Completed'], 10),
      t('Donations', ['person:Donor', 'money:Amount', 'text:Purpose@Scholarship Fund,Infrastructure,Research Grant,Library', 'date:Received', 'status:Status@Received,Pledged'], 24),
      t('Mentorship', ['person:Mentor', 'person:Mentee', 'dept:Area', 'date:Started', 'status:Status@Active,Completed,Paused'], 26),
      t('Success stories', ['person:Alumnus', 'text:Story@Founded a startup,Published research,Global leadership role,Civil services rank', 'int:Batch Year', 'status:Status@Published,Draft'], 14),
      t('Communications', ['text:Campaign@Annual Newsletter,Donation Drive,Reunion Invite', 'int:Recipients', 'pct:Open Rate', 'date:Sent', 'status:Status@Sent,Scheduled,Draft'], 12),
    ],
  },
  {
    id: 'research', label: 'Research', icon: FlaskConical, group: 'Growth & Compliance',
    primaryAction: 'New project',
    tabs: [
      t('Projects', ['id:Project ID', 'text:Project@AI in Education,Smart Materials,Water Treatment,FinTech Adoption,Solar Efficiency', 'person:Principal Investigator', 'dept:Department', 'money:Budget', 'pct:Progress', 'status:Status@Active,Completed,Proposed,On Hold'], 24),
      t('Researchers', ['person:Researcher', 'dept:Department', 'int:Projects', 'int:Publications', 'int:H-Index'], 28),
      t('Publications', ['text:Title@Adaptive Learning Systems,Green Concrete Composites,Deep Learning for Diagnostics', 'person:Author', 'text:Type@Journal,Conference,Book Chapter', 'int:Year', 'int:Citations'], 36),
      t('Grants', ['id:Grant ID', 'text:Agency@AICTE,DST,UGC,CSIR,Private Foundation', 'money:Amount', 'date:Sanctioned', 'status:Status@Active,Closed,Applied'], 20),
      t('Funding agencies', ['text:Agency@AICTE,DST,UGC,CSIR,DRDO,Private Foundation', 'int:Grants', 'money:Total Funding', 'person:Nodal Officer'], 8),
      t('Proposals', ['id:Proposal ID', 'text:Title@AI in Education,Smart Materials,Water Treatment', 'person:Submitted By', 'money:Requested', 'date:Submitted', 'status:Status@Submitted,Under Review,Approved,Rejected'], 18),
      t('Ethics approvals', ['id:Reference', 'text:Project@Clinical Study,Human Subject Survey,Animal Study', 'date:Submitted', 'status:Status@Approved,Pending,Rejected'], 12),
      t('Milestones', ['id:Project ID', 'text:Milestone@Literature Review,Prototype,Field Trial,Final Report', 'datefuture:Due', 'pct:Progress', 'status:Status@Completed,In Progress,Delayed'], 26),
      t('Patents', ['code:Application No', 'text:Title@Low-cost Water Filter,Adaptive Tutoring Method,Solar Tracker', 'person:Inventor', 'date:Filed', 'status:Status@Filed,Published,Granted,Rejected'], 12),
      t('Collaborations', ['text:Partner@IIT Madras,TU Munich,NUS Singapore,Bosch R&D,ISRO', 'text:Type@Academic,Industry,International', 'int:Projects', 'status:Status@Active,MoU Signed,Exploratory'], 12),
    ],
  },
  {
    id: 'accreditation', label: 'Accreditation & Quality', icon: BadgeCheck, group: 'Growth & Compliance',
    tabs: [
      t('Bodies', ['text:Body@NAAC,NBA,NIRF,AICTE,UGC', 'text:Cycle@Cycle 1,Cycle 2,Cycle 3', 'datefuture:Next Review', 'status:Status@Accredited,In Progress,Due'], 8),
      t('Standards', ['code:Standard', 'text:Criterion@Curricular Aspects,Teaching-Learning,Research,Infrastructure,Student Support,Governance', 'int:Weightage', 'pct:Compliance'], 14),
      t('Criteria', ['code:Criterion ID', 'text:Criterion@Curricular Aspects,Teaching-Learning,Research,Infrastructure', 'dept:Owner', 'pct:Completion', 'status:Status@Complete,In Progress,Not Started'], 20),
      t('Evidence', ['code:Evidence ID', 'text:Document@Course File,Feedback Report,Publication List,Audit Statement', 'dept:Department', 'date:Uploaded', 'status:Status@Verified,Pending,Rejected'], 34),
      t('Compliance checklist', ['text:Requirement@Faculty-Student Ratio,Library Volumes,Lab Utilisation,Feedback Mechanism', 'pct:Attainment', 'person:Owner', 'status:Status@Met,Partially Met,Not Met'], 24),
      t('Department submissions', ['dept:Department', 'text:Submission@Self Study Report,Data Template,Evidence Pack', 'datefuture:Due', 'status:Status@Submitted,Pending,Overdue'], 18),
      t('KPI tracking', ['text:KPI@Student-Faculty Ratio,Placement Rate,Research Output,Pass Percentage', 'int:Target', 'int:Actual', 'pct:Achievement', 'status:Status@On Track,At Risk'], 16),
      t('Self-assessment', ['dept:Department', 'text:Criterion@Curricular Aspects,Teaching-Learning,Research', 'rating:Self Score', 'rating:Peer Score', 'status:Status@Submitted,Draft'], 20),
      t('Audit observations', ['id:Observation ID', 'text:Area@Documentation,Infrastructure,Process,Records', 'text:Severity@Minor,Major,Critical', 'date:Raised', 'status:Status@Open,Closed'], 18),
      t('Action plans', ['id:Plan ID', 'text:Action@Update Course Files,Increase Lab Hours,Publish Feedback Analysis', 'person:Owner', 'datefuture:Due', 'status:Status@In Progress,Completed,Overdue'], 18),
    ],
  },
  {
    id: 'documents', label: 'Documents', icon: FileText, group: 'Growth & Compliance',
    primaryAction: 'Upload document',
    tabs: [
      t('Student documents', ['person:Student', 'text:Document@Marksheet,Aadhaar,Transfer Certificate,Photograph', 'date:Uploaded', 'datefuture:Expires', 'status:Status@Verified,Pending,Expired'], 40),
      t('Employee documents', ['person:Employee', 'text:Document@Appointment Letter,PAN,Degree Certificate,Experience Letter', 'date:Uploaded', 'status:Status@Verified,Pending,Expired'], 34),
      t('Academic documents', ['text:Document@Syllabus 2026,Academic Calendar,Exam Regulations,Course File', 'dept:Department', 'date:Updated', 'status:Status@Published,Draft,Archived'], 26),
      t('Templates', ['text:Template@Bonafide Certificate,Offer Letter,Fee Receipt,Experience Letter,Warning Letter', 'int:Version', 'date:Updated', 'status:Status@Active,Draft'], 14),
      t('Certificates', ['person:Issued To', 'text:Type@Bonafide,Course Completion,Character,Migration', 'code:Serial No', 'date:Issued', 'status:Status@Issued,Revoked'], 30),
      t('Letters', ['text:Letter@Appointment Letter,Increment Letter,Warning Letter,Recommendation', 'person:Addressed To', 'date:Issued', 'status:Status@Sent,Draft'], 24),
      t('Version history', ['text:Document@Syllabus 2026,Academic Calendar,Fee Policy', 'int:Version', 'person:Modified By', 'date:Modified', 'status:Status@Current,Superseded'], 22),
      t('Expiry tracking', ['text:Document@Fire Safety Certificate,AICTE Approval,Lab Licence,Vehicle Fitness', 'datefuture:Expires', 'person:Owner', 'status:Status@Active,Expiring,Expired'], 16),
      t('Verification', ['id:Request ID', 'person:Requested By', 'text:Document@Degree Certificate,Transcript,Experience Letter', 'date:Requested', 'status:Status@Verified,Pending,Rejected'], 20),
      t('ID cards', ['person:Holder', 'text:Type@Student,Staff,Faculty,Visitor', 'code:Card No', 'date:Issued', 'datefuture:Valid Till', 'status:Status@Printed,Queued,Reprint Requested,Blocked'], 40),
      t('No-dues clearance', ['person:Student', 'text:Department@Library,Accounts,Hostel,Laboratory,Sports', 'status:Clearance@Cleared,Pending,Blocked', 'person:Cleared By', 'date:Date'], 34),
    ],
  },

  /* -------------------------------------------------------------- Comms */
  {
    id: 'communication', label: 'Communication', icon: MessageSquare, group: 'Engagement',
    primaryAction: 'Compose',
    tabs: [
      custom('Inbox', 'comms-inbox'),
      t('Circulars', ['id:Circular No', 'text:Circular@Annual Day participation,Fee revision notice,Holiday list 2026-27,Exam guidelines,Uniform policy update', 'text:Audience@All Parents,All Staff,Class-wise,Section-wise', 'date:Issued', 'int:Recipients', 'pct:Acknowledged', 'status:Status@Published,Draft,Scheduled'], 22),
      t('Announcements', ['text:Announcement@Semester Fee Deadline,Holiday Notice,Exam Schedule Released,Campus Placement Drive', 'text:Audience@All Students,Faculty,Parents,Campus-wide', 'date:Published', 'int:Reach', 'status:Status@Published,Scheduled,Draft'], 20),
      t('Email', ['text:Subject@Fee Reminder,Result Declaration,Event Invite,Attendance Shortage', 'text:Audience@Students,Parents,Faculty', 'int:Recipients', 'pct:Open Rate', 'status:Status@Sent,Scheduled,Draft,Failed'], 26),
      t('SMS', ['text:Template@Fee Due,Absent Alert,Exam Reminder,OTP', 'int:Recipients', 'pct:Delivered', 'date:Sent', 'status:Status@Delivered,Partial,Failed'], 24),
      t('Push', ['text:Notification@New Result Published,Timetable Updated,Library Due Reminder', 'int:Devices', 'pct:Open Rate', 'date:Sent', 'status:Status@Sent,Scheduled'], 20),
      t('WhatsApp', ['text:Template@Fee Reminder,Attendance Alert,Event Invite', 'int:Recipients', 'pct:Delivered', 'date:Sent', 'status:Status@Delivered,Pending,Failed'], 18),
      t('Templates', ['text:Template@Fee Reminder,Absent Alert,Offer Letter,Exam Reminder', 'text:Channel@Email,SMS,Push,WhatsApp', 'date:Updated', 'status:Status@Active,Draft'], 16),
      t('Campaigns', ['text:Campaign@Fee Collection Drive,Admission Outreach,Alumni Donation', 'text:Channel@Email,SMS,WhatsApp,Multi-channel', 'int:Audience', 'pct:Engagement', 'status:Status@Running,Completed,Draft'], 12),
      t('Logs', ['date:Timestamp', 'text:Channel@Email,SMS,Push,WhatsApp', 'person:Recipient', 'text:Event@Queued,Sent,Delivered,Opened,Bounced', 'status:Status@Delivered,Failed,Pending'], 46),
    ],
  },
  { id: 'parent-portal', label: 'Parent Portal', icon: Baby, group: 'Portals', custom: 'portal-parent', tabs: [] },
  { id: 'student-portal', label: 'Student Portal', icon: User, group: 'Portals', custom: 'portal-student', tabs: [] },
  { id: 'faculty-portal', label: 'Faculty Portal', icon: Presentation, group: 'Portals', custom: 'portal-faculty', tabs: [] },
  {
    id: 'admin-portal', label: 'Admin Portal', icon: Settings2, group: 'Portals',
    tabs: [
      custom('Institution overview', 'admin-overview'),
      t('Campuses', ['campus:Campus', 'city:City', 'int:Students', 'int:Faculty', 'int:Programs', 'status:Status@Active,Planned'], 6),
      t('Users', ['person:User', 'email:Email', 'text:Role@Super Admin,Institution Admin,Principal,Faculty,Accountant,Librarian,Student', 'date:Last Login', 'status:Status@Active,Suspended,Invited'], 44),
      t('Roles', ['text:Role@Super Admin,Institution Admin,Principal,Dean,HOD,Faculty,Accountant,Librarian', 'int:Users', 'int:Permissions', 'status:Status@System,Custom'], 13),
      t('Logs', ['date:Timestamp', 'person:Actor', 'text:Action@Login,Update Record,Delete Record,Export Data,Change Permission', 'text:Module@Finance,Students,HR,Academics', 'status:Status@Success,Failed'], 46),
      custom('System health', 'system-health'),
      t('Configurations', ['text:Key@grading.scheme,fee.late_penalty,attendance.threshold,session.timeout', 'text:Value@Relative Grading,2% per month,75%,30 minutes', 'text:Scope@Global,Campus,Program', 'date:Updated'], 20),
    ],
  },
  {
    id: 'helpdesk', label: 'Helpdesk', icon: LifeBuoy, group: 'Engagement',
    primaryAction: 'New ticket',
    tabs: [
      t('Tickets', ['id:Ticket ID', 'person:Raised By', 'text:Subject@Login issue,Fee receipt missing,Wi-Fi not working,ID card request,Marks discrepancy', 'text:Priority@Low,Medium,High,Critical', 'person:Assignee', 'date:Raised', 'status:Status@Open,In Progress,Resolved,Escalated'], 46),
      t('Categories', ['text:Category@IT Support,Accounts,Academics,Facilities,Hostel', 'int:Tickets', 'int:Open', 'int:Avg Resolution (hrs)'], 8),
      t('SLA', ['text:Priority@Low,Medium,High,Critical', 'int:Response (hrs)', 'int:Resolution (hrs)', 'pct:Compliance', 'status:Status@On Track,Breach'], 6),
      t('Assignee', ['person:Agent', 'text:Team@IT Support,Accounts,Academics,Facilities', 'int:Open Tickets', 'int:Resolved', 'rating:CSAT'], 16),
      t('Comments', ['id:Ticket ID', 'person:Author', 'date:Posted', 'text:Type@Public Reply,Internal Note'], 34),
      t('Resolution', ['id:Ticket ID', 'person:Resolved By', 'int:Time Taken (hrs)', 'date:Resolved', 'status:Status@Resolved,Reopened'], 30),
      t('Satisfaction', ['id:Ticket ID', 'person:Rated By', 'rating:Rating', 'date:Rated', 'text:Sentiment@Positive,Neutral,Negative'], 28),
    ],
  },
  {
    id: 'workflows', label: 'Workflow & Approvals', icon: GitBranch, group: 'Engagement',
    tabs: [
      t('Pending approvals', ['id:Reference', 'text:Type@Leave Request,Purchase Request,Fee Waiver,Marks Correction,Transfer', 'person:Requested By', 'money:Value', 'int:Level', 'status:Status@Pending,Escalated'], 30),
      t('My requests', ['id:Reference', 'text:Type@Leave Request,Reimbursement,Purchase Request', 'date:Raised', 'person:Pending With', 'status:Status@Pending,Approved,Rejected'], 22),
      t('Approval chains', ['text:Workflow@Fee Waiver,Purchase Above ₹1L,Leave Above 5 Days,Marks Correction', 'int:Levels', 'person:Final Approver', 'status:Status@Active,Draft'], 12),
      t('Delegation', ['person:From', 'person:To', 'date:From Date', 'date:To Date', 'status:Status@Active,Expired'], 12),
      t('Escalation', ['id:Reference', 'int:Days Pending', 'person:Escalated To', 'date:Escalated', 'status:Status@Escalated,Resolved'], 14),
      t('Rules', ['text:Rule@Auto-approve below ₹5,000,Escalate after 3 days,Skip level if delegate active', 'text:Applies To@Purchase,Leave,Fee Waiver', 'status:Status@Active,Inactive'], 10),
      t('History', ['id:Reference', 'person:Actor', 'text:Action@Submitted,Approved,Rejected,Escalated,Commented', 'date:Timestamp'], 40),
    ],
  },
  {
    id: 'forms', label: 'Forms', icon: ClipboardList, group: 'Engagement',
    primaryAction: 'Create form',
    tabs: [
      custom('Form builder', 'form-builder'),
      t('Admission forms', ['text:Form@UG Application 2026,PG Application 2026,Lateral Entry', 'int:Fields', 'int:Submissions', 'status:Status@Published,Draft,Closed'], 8),
      t('Survey forms', ['text:Form@Course Feedback,Hostel Satisfaction,Alumni Pulse', 'int:Responses', 'pct:Completion', 'status:Status@Open,Closed'], 10),
      t('Feedback forms', ['text:Form@Faculty Feedback,Infrastructure Feedback,Library Feedback', 'int:Responses', 'rating:Avg Rating', 'status:Status@Open,Closed'], 10),
      t('Leave forms', ['person:Applicant', 'text:Type@Casual,Medical,Duty', 'date:From', 'int:Days', 'status:Status@Approved,Pending,Rejected'], 26),
      t('Request forms', ['person:Requester', 'text:Request@Bonafide Certificate,Duplicate ID Card,Transcript,Bus Pass', 'date:Raised', 'status:Status@Fulfilled,Pending,Rejected'], 28),
      t('Custom fields', ['text:Field@Blood Group,Guardian Occupation,Sports Quota,Hostel Required', 'text:Type@Text,Dropdown,Checkbox,Date,Number', 'text:Module@Students,Admissions,HR', 'status:Status@Active,Inactive'], 18),
      t('Validation rules', ['text:Field@Email,Phone,Aadhaar,Percentage', 'text:Rule@Required,Regex Match,Range Check,Unique', 'status:Status@Active,Inactive'], 12),
    ],
  },

  /* --------------------------------------------------------- Intelligence */
  { id: 'analytics', label: 'Reports & Analytics', icon: BarChart3, group: 'Intelligence', custom: 'analytics', tabs: [] },
  { id: 'ai', label: 'AI Center', icon: Sparkles, group: 'Intelligence', custom: 'ai-center', tabs: [] },

  /* -------------------------------------------------------------- System */
  { id: 'integrations', label: 'Integrations', icon: Plug, group: 'System', custom: 'integrations', tabs: [] },
  {
    id: 'security', label: 'Security', icon: Lock, group: 'System',
    tabs: [
      t('Users', ['person:User', 'email:Email', 'text:Role@Super Admin,Institution Admin,Faculty,Accountant,Student', 'date:Last Login', 'status:MFA@Enabled,Disabled', 'status:Status@Active,Suspended'], 44),
      t('Roles', ['text:Role@Super Admin,Institution Admin,Principal,Dean,HOD,Faculty,Accountant,Librarian,Transport Manager', 'int:Users', 'int:Permissions', 'status:Type@System,Custom'], 13),
      custom('Role matrix', 'role-matrix'),
      t('Login history', ['person:User', 'date:Timestamp', 'city:Location', 'text:Device@Windows · Chrome,macOS · Safari,Android App,iOS App', 'status:Result@Success,Failed,Blocked'], 46),
      t('Active sessions', ['person:User', 'text:Device@Windows · Chrome,macOS · Safari,Android App', 'city:Location', 'date:Started', 'status:Status@Active,Idle'], 26),
      t('Password policy', ['text:Rule@Minimum length,Complexity,Expiry,Reuse restriction,Lockout threshold', 'text:Value@12 characters,Upper+lower+digit+symbol,90 days,Last 5 passwords,5 attempts', 'status:Status@Enforced,Advisory'], 6),
      t('IP restrictions', ['text:Rule@Finance module allowlist,Admin console allowlist,Exam portal allowlist', 'code:CIDR', 'status:Status@Active,Inactive'], 8),
      t('Audit logs', ['date:Timestamp', 'person:Actor', 'text:Action@Permission Change,Data Export,Record Delete,Login,Config Change', 'text:Module@Finance,Students,HR,Security', 'status:Result@Success,Failed'], 48),
      t('Security events', ['date:Timestamp', 'text:Event@Multiple failed logins,Unusual location,Privilege escalation attempt,Bulk export', 'text:Severity@Low,Medium,High,Critical', 'status:Status@Open,Investigating,Resolved'], 24),
      t('Consent', ['person:Data Subject', 'text:Purpose@Marketing Communication,Photo Usage,Data Processing', 'date:Given', 'status:Status@Granted,Withdrawn'], 28),
      t('Privacy requests', ['id:Request ID', 'person:Requester', 'text:Type@Data Access,Data Deletion,Correction,Portability', 'date:Raised', 'status:Status@Completed,In Progress,Rejected'], 16),
    ],
  },
  { id: 'settings', label: 'Settings', icon: Settings, group: 'System', custom: 'settings', tabs: [] },
  { id: 'multicampus', label: 'Multi-campus', icon: Building, group: 'System', custom: 'multicampus', tabs: [] },
]

/**
 * The registry above is the original module set, untouched. applyCoverage folds
 * in the features from the education coverage matrix — extra tabs on existing
 * modules and a handful of new ones — without renaming, reordering or replacing
 * anything already here.
 */
export const MODULES: ModuleDef[] = applyCoverage(BASE_MODULES)

export const MODULE_MAP = Object.fromEntries(MODULES.map((m) => [m.id, m]))

export const GROUP_ORDER = [
  'Overview', 'Academic Operations', 'Finance & Administration', 'People',
  'Campus Services', 'Student Life', 'Growth & Compliance', 'Engagement',
  'Portals', 'Intelligence', 'System',
]

/* ================================ Roles ================================= */
export const ROLES: Role[] = [
  { id: 'super-admin', label: 'Super Admin', scope: 'Group — all institutions', modules: '*' },
  { id: 'institution-admin', label: 'Institution Admin', scope: 'Vivencia Institute of Technology', modules: '*' },
  {
    id: 'principal', label: 'Principal', scope: 'Main Campus — Bengaluru',
    modules: ['dashboard', 'admissions', 'students', 'academics', 'timetable', 'attendance', 'examinations', 'hr', 'placements', 'accreditation', 'analytics', 'ai', 'communication', 'workflows', 'events', 'discipline', 'academic-setup', 'parents', 'obe'],
  },
  {
    id: 'dean', label: 'Dean', scope: 'Faculty of Engineering',
    modules: ['dashboard', 'students', 'academics', 'timetable', 'examinations', 'research', 'workload', 'accreditation', 'analytics', 'workflows', 'academic-setup', 'obe'],
  },
  {
    id: 'hod', label: 'HOD', scope: 'Computer Science & Engineering',
    modules: ['dashboard', 'students', 'academics', 'timetable', 'attendance', 'examinations', 'workload', 'lms', 'research', 'workflows', 'obe'],
  },
  {
    id: 'faculty', label: 'Faculty', scope: 'CSE — 6 sections',
    modules: ['dashboard', 'faculty-portal', 'timetable', 'attendance', 'examinations', 'lms', 'students', 'communication', 'helpdesk', 'parents'],
  },
  {
    id: 'accountant', label: 'Accountant', scope: 'Finance — Bengaluru',
    modules: ['dashboard', 'finance', 'scholarships', 'payroll', 'procurement', 'assets', 'analytics', 'workflows'],
  },
  {
    id: 'hr-manager', label: 'HR Manager', scope: 'People Operations',
    modules: ['dashboard', 'hr', 'payroll', 'recruitment', 'workload', 'documents', 'workflows', 'analytics', 'data-management'],
  },
  { id: 'librarian', label: 'Librarian', scope: 'Central Library', modules: ['dashboard', 'library', 'students', 'communication', 'helpdesk'] },
  { id: 'transport-manager', label: 'Transport Manager', scope: 'Fleet — 23 vehicles', modules: ['dashboard', 'transport', 'assets', 'facilities', 'helpdesk'] },
  { id: 'admission-counselor', label: 'Admission Counselor', scope: 'UG Admissions', modules: ['dashboard', 'admissions', 'students', 'communication', 'forms', 'helpdesk', 'parents'] },
  { id: 'student', label: 'Student', scope: 'B.Tech CSE · Sem 5', modules: ['student-portal', 'lms', 'library', 'events', 'activities', 'helpdesk', 'placements'] },
  { id: 'parent', label: 'Parent', scope: 'Guardian of Aarav Sharma', modules: ['parent-portal', 'communication', 'events', 'helpdesk', 'parents'] },
]

export const ROLE_MAP = Object.fromEntries(ROLES.map((r) => [r.id, r]))

export function modulesForRole(roleId: RoleId): ModuleDef[] {
  const role = ROLE_MAP[roleId]
  if (!role || role.modules === '*') return MODULES
  const allowed = new Set(role.modules as string[])
  return MODULES.filter((m) => allowed.has(m.id))
}
