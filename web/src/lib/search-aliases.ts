/**
 * What people actually type when they are looking for a feature.
 *
 * The catalogue names a screen once, in the product's own vocabulary, and
 * command search matched that name and its summary. A school does not share
 * that vocabulary: a principal looking for the screen that sends a notice
 * types "notice", and the screen is called Circulars, so the search came back
 * empty and the conclusion was that the product cannot send notices. The same
 * happened with "SMTP" against Email Server, "TC" against Certificates &
 * Transfers, and "lead" against Enquiries.
 *
 * Keyed by feature SLUG rather than by full key, deliberately. A slug is the
 * same across every role that carries the feature -- circulars appears in four
 * workspaces -- so one entry teaches the search all of them at once, which is
 * the whole point: the same feature answers to the same words wherever it is
 * filed.
 *
 * Only terms a person would plausibly type. This is not a thesaurus: an alias
 * that matches too broadly pulls the wrong screen to the top of a list whose
 * first result is usually the one taken, so a word earns its place by being
 * what somebody called the thing when they could not find it.
 */
export const SEARCH_ALIASES: Record<string, string[]> = {
  // --- communication ---------------------------------------------------
  // The one this list was written for.
  circulars: ['notice', 'notices', 'announcement', 'announcements', 'memo',
    'bulletin', 'broadcast', 'send notice', 'publish notice', 'noticeboard'],
  messages: ['message', 'chat', 'write to staff', 'contact teacher', 'inbox'],
  communication: ['message', 'notify', 'inform parents'],
  classroom_communication: ['class message', 'message parents', 'class group'],
  direct_teacher_messaging: ['message teacher', 'chat with teacher'],
  grievances: ['complaint', 'complaints', 'escalation', 'feedback'],
  notices_calendar: ['notice', 'announcement', 'events'],

  // --- messaging plumbing ----------------------------------------------
  email_server_smtp_integration: ['smtp', 'mail server', 'email server',
    'outgoing mail', 'email settings', 'email setup', 'email not sending',
    'mail configuration', 'sender address'],
  sms_gateway_integration: ['sms', 'text message', 'dlt', 'sms not sending',
    'gateway', 'sender id'],
  whatsapp_api_integration: ['whatsapp', 'wa', 'whatsapp not sending',
    'business api'],
  automated_trigger_rules: ['auto message', 'automatic reminder', 'triggers',
    'automation', 'reminder rules'],
  integrations: ['connect', 'connector', 'api', 'third party', 'setup'],

  // --- admissions -------------------------------------------------------
  enquiries: ['lead', 'leads', 'inquiry', 'inquiries', 'walk in', 'walk-in',
    'new enquiry', 'prospect'],
  admissions_pipeline: ['funnel', 'lead pipeline', 'admission status'],
  applications: ['application form', 'applicants', 'admission form'],
  application_forms: ['admission form', 'apply online', 'online application'],
  seat_allotment: ['seats', 'allotment', 'merit list'],
  dropped_leads: ['lost leads', 'lost enquiries', 'not converted'],

  // --- students and records --------------------------------------------
  student_360: ['student profile', 'child details', 'student record',
    'full history', 'one student'],
  certificates_transfers: ['tc', 'transfer certificate', 'bonafide',
    'conduct certificate', 'character certificate', 'leaving certificate'],
  class_promotion: ['promote', 'next class', 'year end', 'roll over'],
  student_photographs: ['photo', 'photos', 'student picture', 'id photo'],
  academic_record: ['marks history', 'past results', 'transcript'],

  // --- attendance -------------------------------------------------------
  take_attendance: ['mark attendance', 'register', 'roll call', 'absent'],
  attendance_correction: ['fix attendance', 'amend attendance', 'wrong attendance'],
  attendance_audit: ['attendance check', 'who has not marked'],

  // --- fees -------------------------------------------------------------
  fee_collection: ['collect fee', 'receipt', 'payment', 'take money', 'cash'],
  take_fee_payment: ['collect fee', 'receipt', 'pay fees', 'cash counter'],
  fee_default: ['defaulters', 'unpaid', 'outstanding', 'dues', 'pending fees'],
  unpaid_fees_reminders: ['fee reminder', 'chase dues', 'outstanding reminder'],
  fee_receipts: ['receipt', 'bill', 'proof of payment'],
  online_fee_portal: ['pay online', 'payment link', 'parent payment'],
  payment_gateway_connectors: ['razorpay', 'payment gateway', 'upi', 'online payment setup'],

  // --- staff, access ----------------------------------------------------
  roles_permissions: ['permission', 'access', 'rights', 'who can see',
    'role', 'give access'],
  users: ['login', 'account', 'user', 'password reset', 'create login'],
  staff_records: ['employee', 'teacher details', 'staff profile'],
  staff_joinings_exits: ['joining', 'resignation', 'exit', 'onboarding'],
  monthly_payroll: ['salary', 'pay run', 'payslip', 'wages'],
  leave_absence: ['leave', 'time off', 'holiday request'],

  // --- timetable, exams -------------------------------------------------
  master_timetable: ['timetable', 'schedule', 'periods', 'time table'],
  substitutions: ['cover', 'stand in', 'absent teacher', 'adjustment'],
  marks_entry: ['enter marks', 'grades', 'scores'],
  report_cards: ['report card', 'result', 'marksheet', 'progress report'],
  hall_ticket_issue: ['hall ticket', 'admit card', 'exam slip'],
  question_papers: ['paper', 'exam paper', 'question bank'],

  // --- operations -------------------------------------------------------
  live_bus_tracking: ['bus', 'track bus', 'where is the bus', 'gps'],
  routes_stops: ['bus route', 'stops', 'pickup point'],
  hostel_rooms: ['hostel', 'room allocation', 'boarding'],
  issue_return: ['library', 'issue book', 'return book', 'borrow'],
  data_backup_restore: ['backup', 'restore', 'export data'],
  school_setup: ['setup', 'configure school', 'getting started', 'first run'],
  school_settings: ['settings', 'preferences', 'configuration', 'options'],
  institution_setup: ['settings', 'school profile', 'configure'],
  audit_log: ['audit', 'who changed', 'history', 'trail'],
}

/**
 * aliasText is the searchable string for one feature, or '' if it has none.
 *
 * Joined rather than returned as an array because the caller folds it into a
 * single lowercase haystack, and a lookup that has to allocate per keystroke
 * on 470 features is a lookup that shows up in the input's latency.
 */
export function aliasText(slug: string): string {
  const terms = SEARCH_ALIASES[slug]
  return terms ? terms.join(' ') : ''
}
