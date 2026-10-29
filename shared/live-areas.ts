/* WHAT A WRITE TOUCHES, AND WHICH SCREENS SHOW IT (Yajur, 2026-10-27: "It
   should never repeat again in anything like this").

   A staff phone edited by one admin stayed old for every other admin and role,
   because the live poll only knew a hand-kept list of seven or eight kinds of
   change and the screens each kind refreshed. Every new table or screen was a
   new chance to forget one.

   Now the Worker notes every table a successful write request touched
   (worker/src/live_changes.ts, from the D1 wrapper in index.ts, so no route
   has to remember) and /portal/live hands the names to the web. The web
   (web/src/lib/live.ts) turns each table into the words below and refetches
   the open queries whose key contains one of them. A table this list does not
   know refetches every open query: a miss costs a refetch, never a stale
   screen.

   Two tests keep the list whole: every table of the school database must fall
   into an area here, and every query key the
   web uses must contain a word of some area or be named in UNTRACKED_KEYS
   (web/src/lib/live-areas.test.ts). */

export interface LiveArea {
  /** Tables, by whole name. */
  tables: RegExp
  /** Substrings of query-key strings that show this area. Empty: nothing on screen reads it. */
  words: string[]
}

/** Every summary screen (boards, tiles, attention strip, search) follows every area. */
export const COMMON_WORDS = [
  'home', 'metric', 'attention', 'portal', 'dashboard', 'summary', 'overview', 'rollup', 'bento',
  'count', 'status', 'readiness', 'search', 'ai-', 'timeline', 'my-', 'me-', 'desk', 'queues', 'paged',
  'audit', 'export', 'report', 'student-profile', 'student-record', 'student-detail', 'profile',
]

const PEOPLE = ['student', 'child', 'people', 'roster', 'family', 'guardian', 'parent', 'contact',
  'directory', 'logins', 'issue-one', 'id-card', 'roll', 'class', 'section', 'house', 'alumni', 'admission']
const STAFF = ['employee', 'staff', 'teacher', 'hr', 'people', 'roster', 'admin-users', 'school-logins',
  'login', 'directory', 'contact', 'department', 'designation', 'faculty', 'subject', 'timetable',
  'tt-', 'cover', 'substitution', 'workload', 'hod', 'remarkable', 'reporting', 'users', 'user-', 'issue-one']

export const LIVE_AREAS: Record<string, LiveArea> = {
  /* Bookkeeping of the request itself: nobody's screen shows it. */
  quiet: {
    tables: /^(_migrations|idempotency_keys|rate_limit_hits|login_throttle|cron_runs|live_changes|ref_versions|ai_usage|app_events|help_tip_dismissals)$/,
    words: [],
  },
  access: {
    tables: /^(users|user_roles|roles|role_permissions|user_permissions|permissions|feature_blocks|impersonation_grants|auth_policies|session_policies|api_keys|user_working_years|user_display_preferences|password_resets|email_changes|push_tokens|person_groups|person_group_members)$/,
    words: [...STAFF, ...PEOPLE, 'role', 'permission', 'feature', 'session', 'catalog', 'assignable',
      'installable', 'it-', 'display', 'sign-in', 'admin', 'group', 'signature'],
  },
  sessions: {
    tables: /^(sessions|session_activity|session_activity_views|session_screens|login_events|device_staff_sessions|counselor_access_events|locker_access_events|digital_holding_opens|study_material_views|lms_lesson_views|status_views)$/,
    words: ['session', 'login', 'sign-in', 'it-', 'activity', 'own-', 'usage', 'views', 'status', 'lms', 'digital', 'learning', 'counselor', 'locker'],
  },
  staff: {
    tables: /^(employees|employee_[a-z_]+|staff_(?!attendance)[a-z_]+|departments|designations|work_patterns|duty_[a-z_]+|appraisal[a-z_]*|leave_[a-z_]+|service_book_entries|background_verifications|training_[a-z_]+|job_[a-z_]+|teacher_[a-z_]+|section_subject_teachers|subject_head[a-z_]*|exit_clearances|clearance_departments|biometric_[a-z_]+|council_[a-z_]+|reimbursement_[a-z_]+|evaluation_[a-z_]+|substitution[a-z_]*|transport_staff|medical_fitness_certificates)$/,
    words: [...STAFF, 'leave', 'work-pattern', 'biometric', 'punch', 'appraisal', 'job', 'council',
      'evaluation', 'approval', 'reimburse', 'training', 'exit', 'clearance', 'task', 'grievance', 'remark',
      'recognition', 'onboarding', 'qualification', 'transfer', 'loan', 'payroll', 'salary', 'pay', 'calendar', 'transport'],
  },
  payroll: {
    tables: /^(salary_[a-z_]+|payroll_[a-z_]+|payslips|payout_[a-z_]+|pt_slabs|loan_deductions|investment_declarations)$/,
    words: ['salary', 'payroll', 'payslip', 'pay', 'tax', 'loan', 'gratuity', 'staff', 'hr', 'employee', 'finance', 'year-end'],
  },
  academics: {
    tables: /^(classes|sections|subjects|class_subjects|class_language_options|academic_years|terms|periods|bell_schedules|timetable_[a-z_]+|campuses|syllabus_units|lesson_plan[a-z_]*|instructional_norms|academic_calendar_models|working_days_[a-z_]+|period_closes|accounting_years|student_language_elections|study_groups|study_group_members)$/,
    words: [...PEOPLE, 'subject', 'timetable', 'tt-', 'period', 'bell', 'year', 'term', 'academic', 'teacher',
      'teaching', 'syllabus', 'lesson', 'planner', 'plan', 'campus', 'cover', 'substitution', 'faculty',
      'workload', 'working-days', 'calendar', 'setup', 'option', 'department', 'language', 'group', 'staff', 'exam', 'mark', 'date-range'],
  },
  attendance: {
    tables: /^(student_attendance|attendance_[a-z_]+|staff_attendance[a-z_]*|absence_followup_[a-z_]+|student_absence_followup|night_study_attendance|transport_attendance|health_camp_attendance)$/,
    words: ['attendance', 'absen', 'register', 'att', 'roll', 'class-status', 'shortage', 'sign-in',
      'staff-hours', 'staff-month', 'informed', 'night-study', 'capture', 'staff', 'student', 'transport', 'health', 'camp', 'leave', 'calendar', 'day'],
  },
  calendar: {
    tables: /^(holidays|school_events|event_[a-z_]+|club_[a-z_]+|activities|student_activit[a-z_]+|hall_of_fame_entries|achievement_media|student_achievements|appointments|ptm_[a-z_]+)$/,
    words: ['calendar', 'holiday', 'term', 'school-life', 'event', 'day', 'year-plan', 'activit', 'club',
      'working-days', 'achievement', 'showcase', 'fame', 'ptm', 'appointment', 'student'],
  },
  exams: {
    tables: /^(exams|exam_[a-z_]+|marks|mark_[a-z_]+|grade_bands|grading_scales|report_card[a-z_]*|cce_[a-z_]+|co_scholastic[a-z_]*|hpc_[a-z_]+|question_[a-z_]+|online_test[a-z_]*|board_[a-z_]+|outcome_[a-z_]+|course_outcomes|programme_outcomes|co_po_map|loc_[a-z_]+|abc_credit_entries|student_reading_levels|student_remarks|student_portfolio_[a-z_]+|montessori_[a-z_]+|student_support_[a-z_]+|certificate_types|issued_certificates)$/,
    words: ['exam', 'mark', 'result', 'grade', 'report', 'cce', 'hpc', 'question', 'paper', 'online-test',
      'quiz', 'board', 'outcome', 'loc', 'abc', 'hall', 'seat', 'date-sheet', 'merit', 'progress', 'moderation',
      'academics', 'part', 'reading', 'remark', 'portfolio', 'montessori', 'support-plan', 'classroom', 'cert',
      'student', 'baseline', 'item-analysis', 'dropout', 'grading'],
  },
  finance: {
    tables: /^(invoices|invoice_[a-z_]+|payments|payment_[a-z_]+|fee_[a-z_]+|student_fee_[a-z_]+|refunds|wallet_[a-z_]+|collections_settings|ledger_[a-z_]+|journal_[a-z_]+|bank_[a-z_]+|budget[a-z_]*|vendor[a-z_]*|purchase_[a-z_]+|goods_receipt[a-z_]*|petty_cash_[a-z_]+|fixed_assets|depreciation_charges|tally_[a-z_]+|grant_[a-z_]+|government_aid_schemes|scholarship_[a-z_]+|education_loan_[a-z_]+|numbering_[a-z_]+|pos_[a-z_]+|cafeteria_[a-z_]+|store_[a-z_]+|contractor_bills|prospectus_[a-z_]+|student_bank_accounts|message_credit[a-z_]*|platform_costs)$/,
    words: ['fee', 'invoice', 'ledger', 'finance', 'payment', 'receipt', 'refund', 'concession', 'wallet',
      'collection', 'defaulter', 'cash', 'pdc', 'cheque', 'bank', 'budget', 'vendor', 'purchase', 'tally',
      'grant', 'scholarship', 'loan', 'pos', 'cafeteria', 'store', 'upi', 'approval', 'admission', 'statutory',
      'tax', 'prospectus', 'contractor', 'stock', 'correction', 'student', 'credit', 'comms', 'numbering'],
  },
  comms: {
    tables: /^(announcement[a-z_]*|message_[a-z_]+|messaging_[a-z_]+|parent_teacher_messages|counselor_[a-z_]+|mail_[a-z_]+|sms_gateway_[a-z_]+|notifications|status_[a-z_]+|platform_broadcasts|subject_chat_messages|subject_meeting[a-z_]*|parent_forum_[a-z_]+|call_log|courier_log|driver_notices|student_wall_posts|student_content_moderation|grievance_[a-z_]+|support_ticket[a-z_]*)$/,
    words: ['circular', 'announcement', 'message', 'messaging', 'thread', 'mail', 'inbox', 'sms', 'notification',
      'notif', 'status', 'broadcast', 'comms', 'chat', 'meeting', 'forum', 'parent', 'whatsapp', 'call',
      'courier', 'notice', 'delivery', 'deliveries', 'template', 'rules', 'wall', 'concern', 'helpdesk',
      'grievance', 'ticket', 'counselor', 'leave', 'storage'],
  },
  learning: {
    tables: /^(homework[a-z_]*|lms_[a-z_]+|study_material[a-z_]*|class_diary_entries|student_diary_notes|digital_[a-z_]+|library_[a-z_]+|virtual_[a-z_]+|textbook_indents|university_shortlist_entries)$/,
    words: ['homework', 'lesson', 'lms', 'course', 'video', 'study', 'diary', 'digital', 'library', 'virtual',
      'assignment', 'learning', 'todo', 'quiz', 'classroom', 'textbook', 'university', 'note', 'student'],
  },
  admissions: {
    tables: /^(admission[a-z_]*|application[a-z_]*|enquir[a-z_]+|crm_[a-z_]+|visitor[a-z_]*|import_run[a-z_]*|child_info_[a-z_]+)$/,
    words: [...PEOPLE, 'application', 'enquir', 'lead', 'funnel', 'campaign', 'crm', 'appointment', 'visitor',
      'blocklist', 'open-day', 'waitlist', 'prospectus', 'public-', 'import', 'child-info', 'pending', 'interaction'],
  },
  people: {
    tables: /^(students|student_guardians|guardians|enrollments|student_(documents|health|lockers|year_history|diary)[a-z_]*|emergency_pickup_authorisations|alumni_[a-z_]+|houses|discipline_records|files|wallet|student_[a-z_]+)$/,
    words: [...PEOPLE, 'document', 'health', 'locker', 'pickup', 'discipline', 'note', 'file', 'photo',
      'transport', 'hostel', 'fee', 'attendance', 'mark', 'exam', 'remark', 'year'],
  },
  operations: {
    tables: /^(routes|route_stops|vehicle[a-z_]*|transport_[a-z_]+|trip_checks|hostel_[a-z_]+|mess_menus|health_[a-z_]+|infirmary_visits|medication[a-z_]*|inventory_[a-z_]+|room_inventory[a-z_]*|lost_found[a-z_]+|campus_entry_passes|storage_requests|mdm_[a-z_]+|fixed_[a-z_]+)$/,
    words: ['transport', 'route', 'vehicle', 'bus', 'trip', 'stop', 'driver', 'hostel', 'mess', 'laundry',
      'outpass', 'health', 'infirmary', 'medication', 'camp', 'stock', 'inventory', 'room', 'lost', 'pass',
      'storage', 'ops', 'incident', 'mdm', 'tracker', 'tracking', 'map', 'student', 'staff'],
  },
  settings: {
    tables: /^(institutions|branding_profiles|module_settings|custom_options|integrations|backup_[a-z_]+|report_definitions|report_digest_settings|report_runs|report_shares|location_codes|franchise[a-z_]*|plans|subscriptions|signup_orders|platform_events|ai_[a-z_]+|sqaa_[a-z_]+|statutory[a-z_]*|rollover_log|payment_gateway_credentials|messaging_recipient_policy|audit_log)$/,
    words: ['session', 'bootstrap', 'brand', 'institution', 'school', 'setup', 'settings', 'module', 'option',
      'admin', 'logo', 'catalog', 'report', 'digest', 'location', 'integration', 'backup', 'franchise',
      'plan', 'subscription', 'display', 'help', 'tour', 'sqaa', 'udise', 'statutory', 'rollover', 'ai',
      'year', 'id-card', 'certificate', 'template', 'audit', 'campus', 'payment-settings', 'feature'],
  },
}

/** The area a table belongs to, or null for a table no area names (the web then refetches everything). */
export function areaOf(table: string): string | null {
  for (const [name, a] of Object.entries(LIVE_AREAS)) if (a.tables.test(table)) return name
  return null
}

/** Tables a write may touch without moving anybody's screen; the Worker does not record them. */
export const isQuietTable = (table: string) => LIVE_AREAS.quiet.tables.test(table)

/** The words to refetch for a set of changed tables; null means "everything" (a table no area knows). */
export function wordsFor(tables: string[]): Set<string> | null {
  const words = new Set<string>()
  for (const t of tables) {
    const area = areaOf(t)
    if (area === null) return null
    if (area === 'quiet') continue
    for (const w of LIVE_AREAS[area].words) words.add(w)
    for (const w of COMMON_WORDS) words.add(w)
  }
  return words
}

/** Query keys whose data is not in a school's database (the platform console, static help) or never goes stale. */
export const UNTRACKED_KEYS = /^(seller|sales-|assist$|platform|help|tour|Binary|handbook|public-|my-institutions|institutions|inst-options|it-|day-code|my-day-code|upi-code)/

/** True when some area's word, or a common word, appears in the key. */
export function keyCovered(key: string): boolean {
  if (UNTRACKED_KEYS.test(key)) return true
  if (COMMON_WORDS.some((w) => key.includes(w))) return true
  return Object.values(LIVE_AREAS).some((a) => a.words.some((w) => key.includes(w)))
}
