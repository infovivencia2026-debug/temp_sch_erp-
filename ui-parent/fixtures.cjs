/* Stubbed data for the parent portal: Priya Gupta, mother of Kabir (5-A) and
   Anaya (2-B). Every shape below mirrors the TS interface the screen declares.
   Dates are computed relative to "today" so the fixtures never go stale. */
const fs = require('fs')
const path = require('path')
const esbuild = require('/home/qb/temp_sch_erp-/web/node_modules/esbuild')

const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shift = (days) => {
  const d = new Date(TODAY)
  d.setDate(d.getDate() + days)
  return d
}
const dayISO = (n) => iso(shift(n))
const stamp = (n, h = 9, m = 15) => {
  const d = shift(n)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

// --- catalogue ------------------------------------------------------------
function loadRoles() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'catalog.gen.ts'), 'utf8')
  const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', out.code)(mod, mod.exports)
  return mod.exports.ROLES
}
const ROLES = loadRoles()
const parentRole = ROLES.find((r) => r.key === 'parent')
const parentKeys = parentRole.sections.flatMap((s) => s.features.map((f) => f.key))

const catalog = {
  setup_required: false,
  active_role: 'parent',
  roles: [
    {
      key: parentRole.key,
      name: parentRole.name,
      sections: parentRole.sections.map((s) => ({
        slug: s.slug,
        name: s.name,
        workspace: s.workspace,
        features: s.features.map((f) => ({ ...f, in_scope: true, live: true })),
      })),
    },
  ],
  scope: { platform_admin: false, all_campuses: false, campuses: 1, departments: 0, sections: 2, students: 2 },
  implemented: parentKeys,
}

const session = {
  authenticated: true,
  user: { id: 'u-priya', full_name: 'Priya Gupta', roles: ['parent'], platform_admin: false },
  institution: {
    id: 'inst-1', name: 'Vivencia International School', short_name: 'Vivencia', slug: 'vivencia',
    primary_color: '#0f766e', timezone: 'Asia/Kolkata', locale: 'en-IN',
  },
  permissions: [...parentKeys, 'portal.read', 'portal.write', 'comms.circulars.read'],
  modules: [],
  subscription: { active: true, plan_code: 'std', plan_name: 'Standard', status: 'active', modules: ['transport', 'fees', 'comms'] },
}

// --- the family -----------------------------------------------------------
const KABIR = 'st-kabir'
const ANAYA = 'st-anaya'
const children = [
  { student_id: KABIR, admission_no: 'VIS/2021/0412', full_name: 'Kabir Gupta', class_name: 'Class 5', section_name: 'A', roll_no: 14, relation: 'Mother' },
  { student_id: ANAYA, admission_no: 'VIS/2024/0097', full_name: 'Anaya Gupta', class_name: 'Class 2', section_name: 'B', roll_no: 7, relation: 'Mother' },
]
const byId = Object.fromEntries(children.map((c) => [c.student_id, c]))
const nameOf = (id) => byId[id]?.full_name ?? 'Kabir Gupta'

// Attendance: ~120 school days back from today, Mon–Sat, with a few absences.
function register(seed) {
  const days = []
  let n = 0
  for (let back = 0; days.length < 120 && back < 200; back++) {
    const d = shift(-back)
    const dow = d.getDay()
    if (dow === 0) continue
    n++
    let status = 'present'
    if ((n * 7 + seed) % 23 === 0) status = 'absent'
    else if ((n * 11 + seed) % 31 === 0) status = 'late'
    else if ((n * 13 + seed) % 47 === 0) status = 'half_day'
    let label
    if (iso(d) === '2026-08-15') { status = 'holiday'; label = 'Independence Day' }
    if (iso(d) === '2026-09-04') { status = 'holiday'; label = 'Milad-un-Nabi' }
    if (iso(d) === '2026-08-27') { status = 'holiday'; label = 'Ganesh Chaturthi' }
    days.push({ date: iso(d), status, ...(label ? { label, kind: 'holiday' } : {}), on_leave: false })
  }
  return days.reverse()
}
const registers = { [KABIR]: register(3), [ANAYA]: register(5) }

function summary(id) {
  const days = registers[id]
  const marked = days.filter((d) => d.status !== 'holiday')
  const present = marked.filter((d) => d.status === 'present' || d.status === 'late').length
  const absent = marked.filter((d) => d.status === 'absent').length
  const kabir = id === KABIR
  return {
    student_id: id,
    full_name: nameOf(id),
    attendance_pct: Math.round((present / marked.length) * 100),
    present_days: present,
    total_days: marked.length,
    absent_days: absent,
    homework_due: kabir ? 2 : 1,
    next_homework_due: dayISO(kabir ? 1 : 3),
    next_homework_title: kabir ? 'Fractions worksheet 4' : 'Draw your family',
    outstanding_paise: kabir ? 2450000 : 0,
    next_exam: kabir ? 'Half-yearly examination · 21 Sep' : 'Periodic test 2 · 24 Sep',
    latest_result_exam: 'Periodic test 1',
    latest_result_pct: kabir ? 84.5 : 91.0,
    latest_result_grade: kabir ? 'A' : 'A+',
    today: kabir
      ? [
          { period: 'Period 1', starts_at: '08:30', ends_at: '09:10', subject: 'Mathematics', teacher: 'Sunita Rao', room: '5A' },
          { period: 'Period 2', starts_at: '09:10', ends_at: '09:50', subject: 'English', teacher: 'Farah Khan', room: '5A' },
          { period: 'Period 3', starts_at: '09:50', ends_at: '10:30', subject: 'EVS', teacher: 'Ravi Menon', room: 'Lab 2' },
          { period: 'Break', starts_at: '10:30', ends_at: '10:50', subject: 'Break' },
          { period: 'Period 4', starts_at: '10:50', ends_at: '11:30', subject: 'Hindi', teacher: 'Meera Joshi', room: '5A' },
          { period: 'Period 5', starts_at: '11:30', ends_at: '12:10', subject: 'Computer', teacher: 'Arjun Sethi', room: 'ICT lab' },
          { period: 'Period 6', starts_at: '12:10', ends_at: '12:50', subject: 'Physical education', teacher: 'Coach Dev', room: 'Ground' },
        ]
      : [
          { period: 'Period 1', starts_at: '08:30', ends_at: '09:10', subject: 'English', teacher: 'Neha Iyer', room: '2B' },
          { period: 'Period 2', starts_at: '09:10', ends_at: '09:50', subject: 'Mathematics', teacher: 'Neha Iyer', room: '2B' },
          { period: 'Period 3', starts_at: '09:50', ends_at: '10:30', subject: 'Art', teacher: 'Pooja Nair', room: 'Art room' },
          { period: 'Break', starts_at: '10:30', ends_at: '10:50', subject: 'Break' },
          { period: 'Period 4', starts_at: '10:50', ends_at: '11:30', subject: 'Hindi', teacher: 'Meera Joshi', room: '2B' },
          { period: 'Period 5', starts_at: '11:30', ends_at: '12:10', subject: 'Music', teacher: 'Sam Thomas', room: 'Music room' },
        ],
  }
}

function fees(id) {
  const kabir = id === KABIR
  const tuition = kabir ? 4200000 : 3600000
  const inv = (n, issued, due, paid, fine = 0, extra = []) => {
    const lines = [
      { head: 'Tuition fee', amount_paise: tuition },
      { head: 'Transport fee', amount_paise: 450000 },
      ...extra,
    ]
    const net = lines.reduce((a, l) => a + l.amount_paise, 0) + fine
    const duePaise = Math.max(0, net - paid)
    const overdue = duePaise > 0 ? Math.max(0, Math.round((TODAY - new Date(due)) / 86400000)) : 0
    return {
      invoice_no: `INV/26-27/${kabir ? '0412' : '0097'}-${n}`,
      instalment_no: n,
      lines: fine ? [...lines, { head: 'Late fee', amount_paise: fine, is_fine: true }] : lines,
      issued_on: issued, due_on: due,
      net_paise: net, paid_paise: paid, due_paise: duePaise, fine_paise: fine,
      status: duePaise === 0 ? 'paid' : overdue > 0 ? 'overdue' : 'due',
      days_overdue: overdue,
    }
  }
  const invoices = kabir
    ? [
        inv(1, '2026-04-01', '2026-04-15', 4650000),
        inv(2, '2026-07-01', '2026-07-15', 4650000),
        inv(3, '2026-08-20', dayISO(-12), 2200000, 0, []),
      ]
    : [
        inv(1, '2026-04-01', '2026-04-15', 4050000),
        inv(2, '2026-07-01', '2026-07-15', 4050000),
        inv(3, '2026-08-20', dayISO(20), 4050000),
      ]
  // Kabir's third instalment: net 46,50,000 paise; paid 22,00,000 → due 24,50,000
  const receipts = kabir
    ? [
        { receipt_no: 'RCP/26-27/1042', paid_on: '2026-04-09', amount_paise: 4650000, mode: 'upi', reference_no: 'UPI2604091822', status: 'success' },
        { receipt_no: 'RCP/26-27/2318', paid_on: '2026-07-11', amount_paise: 4650000, mode: 'netbanking', reference_no: 'HDFC71104421', status: 'success' },
        { receipt_no: 'RCP/26-27/3107', paid_on: '2026-08-28', amount_paise: 2200000, mode: 'upi', reference_no: 'UPI2608281041', status: 'success' },
      ]
    : [
        { receipt_no: 'RCP/26-27/1043', paid_on: '2026-04-09', amount_paise: 4050000, mode: 'upi', reference_no: 'UPI2604091823', status: 'success' },
        { receipt_no: 'RCP/26-27/2319', paid_on: '2026-07-11', amount_paise: 4050000, mode: 'netbanking', reference_no: 'HDFC71104422', status: 'success' },
        { receipt_no: 'RCP/26-27/3211', paid_on: '2026-09-01', amount_paise: 4050000, mode: 'card', reference_no: 'RZP9012', status: 'success' },
      ]
  return {
    student_id: id,
    student_name: nameOf(id),
    outstanding_paise: invoices.reduce((a, i) => a + i.due_paise, 0),
    invoices,
    receipts,
  }
}

const receiptRows = [KABIR, ANAYA].flatMap((id) =>
  fees(id).receipts.map((r, i) => ({
    payment_id: `pay-${id}-${i}`, receipt_no: r.receipt_no, student_id: id, student_name: nameOf(id),
    amount_paise: r.amount_paise, mode: r.mode, status: r.status, paid_on: r.paid_on, reference_no: r.reference_no,
  })),
)
function receiptDetail(paymentId) {
  const row = receiptRows.find((r) => r.payment_id === paymentId) ?? receiptRows[0]
  const c = byId[row.student_id]
  return {
    receipt_no: row.receipt_no, amount_paise: row.amount_paise,
    amount_words: 'Rupees forty-six thousand five hundred only', mode: row.mode, status: row.status,
    paid_on: row.paid_on, reference_no: row.reference_no, student_name: row.student_name,
    admission_no: c.admission_no, institution: 'Vivencia International School', class_name: c.class_name,
    section_name: c.section_name, financial_year: '2026-27',
    lines: [
      { invoice_no: 'INV/26-27/0412-1', amount_paise: row.amount_paise - 450000, particulars: 'Tuition fee' },
      { invoice_no: 'INV/26-27/0412-1', amount_paise: 450000, particulars: 'Transport fee' },
    ],
  }
}

function results(id) {
  const kabir = id === KABIR
  const subjects = kabir
    ? ['Mathematics', 'English', 'Hindi', 'EVS', 'Computer']
    : ['English', 'Mathematics', 'Hindi', 'EVS']
  const marks = kabir ? [42, 38, 44, 40, 47] : [46, 44, 45, 47]
  return {
    student_id: id,
    published: true,
    cards: [
      {
        id: `card-${id}-pt1`, exam: 'Periodic test 1', term: 'Term 1',
        total_marks: marks.reduce((a, b) => a + b, 0), max_marks: subjects.length * 50,
        percentage: kabir ? 84.5 : 91.0, grade: kabir ? 'A' : 'A+', rank_in_section: kabir ? 6 : 3,
        attendance_percent: kabir ? 93 : 96,
        class_teacher_remarks: kabir ? 'Works well in groups. Needs to show working in maths.' : 'A joyful, curious learner.',
        published_at: '2026-08-18',
      },
    ],
    subjects: subjects.map((s, i) => ({
      exam: 'Periodic test 1', subject: s, marks_obtained: marks[i], max_marks: 50,
      grade: marks[i] >= 45 ? 'A+' : marks[i] >= 40 ? 'A' : 'B+', is_absent: false,
    })),
  }
}

const homework = (studentId) => ({
  items: [
    {
      id: 'hw-1', title: 'Fractions worksheet 4', kind: 'homework', subject: 'Mathematics', class_name: 'Class 5', section_name: 'A',
      assigned_on: dayISO(-2), due_on: dayISO(1), instructions: 'Q1–Q12 from the worksheet. Show your working.',
      overdue: false, submissions: 18, strength: 34, submitted: false, teacher: 'Sunita Rao',
      files: [{ file_id: 'f-hw1', name: 'fractions-ws4.pdf', content_type: 'application/pdf', size_bytes: 182000 }],
    },
    {
      id: 'hw-2', title: 'Reading log: The Jungle Book, ch. 3', kind: 'homework', subject: 'English', class_name: 'Class 5', section_name: 'A',
      assigned_on: dayISO(-1), due_on: dayISO(4), instructions: 'Read chapter 3 and write five sentences about Mowgli.',
      overdue: false, submissions: 4, strength: 34, submitted: false, teacher: 'Farah Khan',
    },
    {
      id: 'hw-3', title: 'Water cycle diagram', kind: 'classwork', subject: 'EVS', class_name: 'Class 5', section_name: 'A',
      assigned_on: dayISO(-6), due_on: dayISO(-3), instructions: 'Label the stages.', overdue: false,
      submissions: 34, strength: 34, submitted: true, teacher: 'Ravi Menon',
    },
  ].filter(() => true),
})

const circulars = {
  items: [
    {
      id: 'c-1', title: 'Half-yearly examination datesheet', kind: 'notice', audience_role: 'parents', requires_ack: true,
      published_at: dayISO(-1), published_at_full: stamp(-1, 16, 5), published_by: 'Principal', acknowledgements: 312, sections: 24,
      body: 'The half-yearly examinations for Classes 1 to 8 begin on Monday 21 September. The datesheet is attached. School closes at 12:30 on examination days; buses leave at 12:45.',
      acknowledged_by_me: false,
    },
  ],
}

const notifications = {
  unread: 3,
  items: [
    { id: 'n-1', kind: 'fee', title: 'Fee instalment overdue', body: '₹24,500 for Kabir was due 12 days ago.', link: '/parent/fees/fees_payments', student_name: 'Kabir Gupta', created_at: stamp(0, 7, 30) },
    { id: 'n-2', kind: 'message', title: 'Message from Sunita Rao', body: 'Kabir did very well in today\'s mental maths round.', link: '/parent/messages/direct_teacher_messaging', student_name: 'Kabir Gupta', created_at: stamp(-1, 14, 10) },
    { id: 'n-3', kind: 'circular', title: 'Half-yearly examination datesheet', body: 'Please acknowledge.', link: '/parent/messages/communication', created_at: stamp(-1, 16, 5) },
    { id: 'n-4', kind: 'ptm', title: 'PTM booked', body: 'Tuesday 10:20 with Neha Iyer for Anaya.', link: '/parent/school_life/parent_teacher_meeting_booking', student_name: 'Anaya Gupta', created_at: stamp(-3, 9, 0), read_at: stamp(-3, 9, 5) },
    { id: 'n-5', kind: 'bus', title: 'Bus arrived at school', body: 'Route 7 reached campus at 8:05.', student_name: 'Kabir Gupta', created_at: stamp(-3, 8, 5), read_at: stamp(-3, 8, 20) },
  ],
}

const attention = {
  items: [
    { key: 'fee-overdue', severity: 'high', headline: '₹24,500 overdue for Kabir', detail: 'Instalment 3 was due 12 days ago.', href: '/parent/fees/fees_payments', action: 'Pay now' },
    { key: 'ack-circular', severity: 'medium', headline: 'Acknowledge the exam datesheet', detail: 'The school has asked every parent to confirm they have read it.', href: '/parent/messages/communication', action: 'Read' },
    { key: 'hw-due', severity: 'low', headline: 'Fractions worksheet due tomorrow', detail: 'Kabir · Mathematics', href: '/parent/academics/homework_academics', action: 'Open' },
  ],
}

const bus = {
  stale_after_seconds: 90,
  parents_may_watch: true,
  items: [
    {
      student_id: KABIR, student_name: 'Kabir Gupta', route: 'Route 7 · Jubilee Hills', registration_no: 'TS 09 UB 4471',
      direction: 'drop', driver: 'Ramesh Yadav', driver_phone: '+91 98480 12345', stop: 'Road No. 10, near Apollo',
      scheduled_at: '15:40', latitude: 17.4325, longitude: 78.4071, stop_latitude: 17.4239, stop_longitude: 78.4138,
      age_seconds: 12, metres_away: 1450, eta_minutes: 6, speed_kmph: 22, state: 'running', refresh_seconds: 15,
      proximity_m: 500, watchable: true,
    },
    {
      student_id: ANAYA, student_name: 'Anaya Gupta', route: 'Route 7 · Jubilee Hills', registration_no: 'TS 09 UB 4471',
      direction: 'drop', driver: 'Ramesh Yadav', driver_phone: '+91 98480 12345', stop: 'Road No. 10, near Apollo',
      scheduled_at: '15:40', latitude: 17.4325, longitude: 78.4071, stop_latitude: 17.4239, stop_longitude: 78.4138,
      age_seconds: 12, metres_away: 1450, eta_minutes: 6, speed_kmph: 22, state: 'running', refresh_seconds: 15,
      proximity_m: 500, watchable: true,
    },
  ],
}

const teachers = (id) =>
  id === ANAYA
    ? { items: [
        { user_id: 't-neha', full_name: 'Neha Iyer', subject: 'Class teacher · English', class_teacher: true, unread: 0 },
        { user_id: 't-pooja', full_name: 'Pooja Nair', subject: 'Art', class_teacher: false, unread: 0 },
      ] }
    : { items: [
        { user_id: 't-sunita', full_name: 'Sunita Rao', subject: 'Class teacher · Mathematics', class_teacher: true, unread: 1 },
        { user_id: 't-farah', full_name: 'Farah Khan', subject: 'English', class_teacher: false, unread: 0 },
        { user_id: 't-ravi', full_name: 'Ravi Menon', subject: 'EVS', class_teacher: false, unread: 0 },
      ] }
const messages = {
  items: [
    { id: 'm-1', body: 'Good afternoon. Kabir has been missing his maths homework twice this month — could you check his diary tonight?', sent_at: stamp(-4, 13, 40), sender_name: 'Sunita Rao', mine: false, read_at: stamp(-4, 18, 0) },
    { id: 'm-2', body: 'Thank you for letting me know. He has an exam schedule on the fridge now — we will keep an eye on it.', sent_at: stamp(-4, 19, 2), sender_name: 'Priya Gupta', mine: true, read_at: stamp(-3, 8, 0) },
    { id: 'm-3', body: 'Kabir did very well in today\'s mental maths round. Full marks!', sent_at: stamp(-1, 14, 10), sender_name: 'Sunita Rao', mine: false },
  ],
}

const remarks = {
  items: [
    { id: 'r-1', student_id: KABIR, child_name: 'Kabir Gupta', observed_on: dayISO(-1), kind: 'commendation', body: 'Full marks in the mental maths round. Very quick recall.', subject: 'Mathematics', class_name: 'Class 5', section_name: 'A', teacher: 'Sunita Rao' },
    { id: 'r-2', student_id: KABIR, child_name: 'Kabir Gupta', observed_on: dayISO(-9), kind: 'concern', body: 'Homework not submitted twice this month.', subject: 'Mathematics', class_name: 'Class 5', section_name: 'A', teacher: 'Sunita Rao' },
    { id: 'r-3', student_id: ANAYA, child_name: 'Anaya Gupta', observed_on: dayISO(-6), kind: 'commendation', body: 'Read aloud beautifully at assembly.', subject: 'English', class_name: 'Class 2', section_name: 'B', teacher: 'Neha Iyer' },
  ],
}

const calendar = {
  from: dayISO(-30), to: dayISO(60),
  items: [
    { date: dayISO(-1), kind: 'holiday', title: 'Milad-un-Nabi' },
    { date: dayISO(4), kind: 'ptm', title: 'Parent–teacher meeting', detail: 'Booked · 10:20 with Neha Iyer', starts_at: '10:20', venue: 'Room 2B', student_name: 'Anaya Gupta' },
    { date: dayISO(6), kind: 'event', title: 'Inter-house football', venue: 'Main ground', starts_at: '14:00', ref_id: 'ev-1' },
    { date: dayISO(16), end_date: dayISO(24), kind: 'exam', title: 'Half-yearly examination', detail: 'Classes 1–8', student_name: 'Kabir Gupta' },
    { date: dayISO(27), end_date: dayISO(35), kind: 'holiday', title: 'Dussehra break' },
    { date: dayISO(41), kind: 'event', title: 'Annual day rehearsals begin', venue: 'Auditorium', ref_id: 'ev-2' },
  ],
}

const ptmSlots = {
  items: [
    { id: 's-1', teacher: 'Neha Iyer', section: 'Class 2-B', on_date: dayISO(4), starts_at: '10:00', minutes: 20, mode: 'in_person', location: 'Room 2B', taken: true },
    { id: 's-2', teacher: 'Neha Iyer', section: 'Class 2-B', on_date: dayISO(4), starts_at: '10:20', minutes: 20, mode: 'in_person', location: 'Room 2B', taken: true, booked_for: 'Anaya Gupta' },
    { id: 's-3', teacher: 'Neha Iyer', section: 'Class 2-B', on_date: dayISO(4), starts_at: '10:40', minutes: 20, mode: 'in_person', location: 'Room 2B', taken: false },
    { id: 's-4', teacher: 'Sunita Rao', section: 'Class 5-A', on_date: dayISO(4), starts_at: '11:00', minutes: 15, mode: 'in_person', location: 'Room 5A', taken: false },
    { id: 's-5', teacher: 'Sunita Rao', section: 'Class 5-A', on_date: dayISO(4), starts_at: '11:15', minutes: 15, mode: 'online', notes: 'Google Meet link is sent an hour before.', taken: false },
  ],
}
const ptmBookings = {
  items: [
    { id: 'b-1', student_id: ANAYA, student_name: 'Anaya Gupta', teacher: 'Neha Iyer', on_date: dayISO(4), starts_at: '10:20', minutes: 20, purpose: 'Reading progress and the Hindi worksheets', status: 'booked', cancellable: true },
    { id: 'b-0', student_id: KABIR, student_name: 'Kabir Gupta', teacher: 'Sunita Rao', on_date: dayISO(-40), starts_at: '11:00', minutes: 15, purpose: 'Maths homework', status: 'done', outcome: 'Agreed a homework diary check every evening.', cancellable: false, concerns: 'Missed homework', agreed_actions: 'Diary check nightly' },
  ],
}

const leave = {
  items: [
    { id: 'l-1', student_id: ANAYA, student_name: 'Anaya Gupta', from_date: dayISO(8), to_date: dayISO(9), days: 2, is_half_day: false, reason: 'Cousin\'s wedding in Vijayawada', status: 'pending', applied_on: dayISO(-1), cancellable: true },
    { id: 'l-2', student_id: KABIR, student_name: 'Kabir Gupta', from_date: dayISO(-20), to_date: dayISO(-20), days: 1, is_half_day: false, reason: 'Fever', status: 'approved', decided_by: 'Sunita Rao', decided_at: stamp(-19, 8, 30), applied_on: dayISO(-21), cancellable: false },
  ],
}

const requests = {
  items: [
    { id: 'q-1', student_id: KABIR, student_name: 'Kabir Gupta', serial_no: 'BON/26/0142', type: 'Bonafide certificate', code: 'bonafide', status: 'issued', issued_on: dayISO(-30), reason: 'Passport application', has_file: true },
    { id: 'q-2', student_id: ANAYA, student_name: 'Anaya Gupta', serial_no: 'ID/26/0031', type: 'Duplicate ID card', code: 'id_card', status: 'requested', issued_on: dayISO(-2), reason: 'Lost on the bus', has_file: false },
  ],
}
const requestTypes = {
  items: [
    { id: 'rt-1', code: 'bonafide', name: 'Bonafide certificate', requires_approval: false },
    { id: 'rt-2', code: 'tc', name: 'Transfer certificate', requires_approval: true },
    { id: 'rt-3', code: 'conduct', name: 'Conduct certificate', requires_approval: true },
    { id: 'rt-4', code: 'id_card', name: 'Duplicate ID card', requires_approval: false },
  ],
}
const documents = {
  items: [
    { id: 'd-1', student_id: KABIR, student_name: 'Kabir Gupta', doc_type: 'Birth certificate', file_name: 'kabir-birth-cert.pdf', size_bytes: 412000, uploaded_on: '2021-03-12', verified: true, verified_by: 'Admissions office' },
    { id: 'd-2', student_id: KABIR, student_name: 'Kabir Gupta', doc_type: 'Aadhaar', file_name: 'kabir-aadhaar.pdf', size_bytes: 310000, uploaded_on: '2021-03-12', verified: true, verified_by: 'Admissions office' },
    { id: 'd-3', student_id: ANAYA, student_name: 'Anaya Gupta', doc_type: 'Birth certificate', file_name: 'anaya-birth-cert.pdf', size_bytes: 398000, uploaded_on: '2024-02-02', verified: true, verified_by: 'Admissions office' },
    { id: 'd-4', student_id: ANAYA, student_name: 'Anaya Gupta', doc_type: 'Transfer certificate', file_name: 'anaya-tc.pdf', size_bytes: 220000, uploaded_on: '2024-02-02', verified: false, notes: 'Awaiting the previous school\'s seal.' },
  ],
}

const pickups = {
  items: [
    { id: 'p-1', student_id: KABIR, student_name: 'Kabir Gupta', full_name: 'Rohan Gupta', phone: '+91 98490 55512', relation: 'Uncle', id_type: 'Aadhaar', id_last4: '4471', valid_on: dayISO(0), reason: 'Both parents at a hospital appointment', code: 'PK-7Q2M', status: 'live', created_at: stamp(0, 7, 55) },
    { id: 'p-0', student_id: ANAYA, student_name: 'Anaya Gupta', full_name: 'Lakshmi Devi', phone: '+91 98490 11002', relation: 'Grandmother', valid_on: dayISO(-12), reason: 'Parents travelling', code: 'PK-3N8T', status: 'used', used_at: stamp(-12, 15, 52), released_by: 'Gate 2', created_at: stamp(-12, 7, 10) },
  ],
}

const outpasses = { items: [] }

const gallery = {
  items: [
    { id: 'g-1', name: 'Independence Day 2026', kind: 'event', on_date: '2026-08-15', venue: 'Main ground', description: 'Flag hoisting and the march past.', photo_count: 48, video_count: 2, cover_file_id: 'img-1' },
    { id: 'g-2', name: 'Science exhibition', kind: 'academic', on_date: '2026-08-22', venue: 'Block B', photo_count: 31, video_count: 0, cover_file_id: 'img-2', section: 'Class 5-A' },
    { id: 'g-3', name: 'Class 2 art week', kind: 'class', on_date: '2026-08-29', photo_count: 22, video_count: 1, cover_file_id: 'img-3', section: 'Class 2-B' },
  ],
}
const galleryAlbum = (id) => ({
  album: gallery.items.find((a) => a.id === id) ?? gallery.items[0],
  items: Array.from({ length: 9 }, (_, i) => ({
    id: `gi-${i}`, file_id: `img-${(i % 3) + 1}`, media_kind: i === 4 ? 'video' : 'photo', caption: i === 0 ? 'The march past' : undefined,
    original_name: `IMG_${1200 + i}.jpg`, content_type: 'image/jpeg', size_bytes: 820000, published_on: '2026-08-16',
  })),
})

const eventPasses = {
  items: [
    { id: 'ep-1', event_id: 'ev-2', event_name: 'Annual day 2026', on_date: dayISO(41), starts_at: '17:30', venue: 'Auditorium', student_id: KABIR, student_name: 'Kabir Gupta', row_label: 'F', seat_from: 12, seats: 2, code: 'AD26-F12-2', issued_at: stamp(-2, 10, 0) },
  ],
}

const iep = (id) => ({
  student_name: nameOf(id),
  has_plan: id === ANAYA,
  plan: id === ANAYA
    ? { id: 'iep-1', concern: 'Speech clarity', accommodations: 'Extra time on reading aloud; seat near the teacher.', exam_concession: 'None', external_support: 'Speech therapy, weekly', review_on: dayISO(30), status: 'active' }
    : {},
  goals: id === ANAYA
    ? [
        { id: 'goal-1', title: 'Read a 6-sentence passage clearly', domain: 'Speech', baseline_value: 2, target_value: 6, latest_value: 4, latest_on: dayISO(-3), unit: 'sentences', higher_is_better: true, starts_on: '2026-06-10', target_on: dayISO(60), status: 'on_track', progress_percent: 50,
          updates: [{ on_date: '2026-06-10', value: 2 }, { on_date: '2026-07-15', value: 3, note: 'Slower but clearer' }, { on_date: dayISO(-3), value: 4 }] },
        { id: 'goal-2', title: 'Answer in full sentences', domain: 'Language', baseline_value: 20, target_value: 80, latest_value: 55, latest_on: dayISO(-10), unit: '%', higher_is_better: true, starts_on: '2026-06-10', target_on: dayISO(90), status: 'on_track', progress_percent: 58, updates: [] },
      ]
    : [],
})

const cafeteria = {
  items: [
    { id: 'cf-1', student_id: KABIR, student_name: 'Kabir Gupta', purchased_at: stamp(0, 10, 42), on_date: dayISO(0), at_time: '10:42', counter: 'Counter 1', total_paise: 6500, mode: 'wallet', kcal: 410,
      items: [{ item_name: 'Veg puff', category: 'snack', quantity: 1, unit_paise: 2500, line_paise: 2500, kcal: 260, is_vegetarian: true }, { item_name: 'Mango juice', category: 'drink', quantity: 1, unit_paise: 4000, line_paise: 4000, kcal: 150, is_vegetarian: true }] },
    { id: 'cf-2', student_id: KABIR, student_name: 'Kabir Gupta', purchased_at: stamp(-1, 12, 55), on_date: dayISO(-1), at_time: '12:55', counter: 'Counter 2', total_paise: 8000, mode: 'wallet', kcal: 620,
      items: [{ item_name: 'Veg thali', category: 'meal', quantity: 1, unit_paise: 8000, line_paise: 8000, kcal: 620, is_vegetarian: true }] },
  ],
  days: [
    { on_date: dayISO(0), total_paise: 6500, kcal: 410, purchases: 1 },
    { on_date: dayISO(-1), total_paise: 8000, kcal: 620, purchases: 1 },
    { on_date: dayISO(-2), total_paise: 4500, kcal: 300, purchases: 1 },
  ],
}

const studentCard = (id) => {
  const c = byId[id] ?? children[0]
  return {
    card: {
      student_id: c.student_id, full_name: c.full_name, admission_no: c.admission_no, class_name: c.class_name, section_name: c.section_name,
      roll_no: c.roll_no, date_of_birth: id === ANAYA ? '2019-11-03' : '2016-02-21', blood_group: 'B+', house: id === ANAYA ? 'Ruby' : 'Sapphire',
      guardian_name: 'Priya Gupta', guardian_phone: '+91 98490 22331', school_name: 'Vivencia International School', campus_name: 'Jubilee Hills', status: 'active',
    },
    pass: { serial: 'S-4471', code: 'VIS-KG-9021', scan: 'VIS|st-kabir|9021|' + Date.now(), expires_in_seconds: 120 },
  }
}
const parentCard = {
  card: { user_id: 'u-priya', full_name: 'Priya Gupta', phone: '+91 98490 22331', email: 'priya.gupta@example.com', relation: 'Mother', school_name: 'Vivencia International School' },
  children: children.map((c) => ({ student_id: c.student_id, full_name: c.full_name, class_name: c.class_name, section_name: c.section_name })),
  pass: { serial: 'P-2233', code: 'VIS-PG-1188', scan: 'VIS|u-priya|1188|' + Date.now(), expires_in_seconds: 120 },
}

const admission = { items: [] }

const preferences = {
  preference: { theme: 'system', density: 'comfortable', reduce_motion: false, locale: 'en', high_contrast: false },
  theme_choices: ['system', 'light', 'dark'], density_choices: ['comfortable', 'compact'], locale_choices: ['en', 'te'],
  default_theme: 'system', default_density: 'comfortable', default_locale: 'en',
}

const staffRemarks = { items: [] }
const staffRemarkTeachers = {
  items: [
    { user_id: 't-sunita', full_name: 'Sunita Rao', subject: 'Mathematics', relation: 'Class teacher of Kabir Gupta' },
    { user_id: 't-neha', full_name: 'Neha Iyer', subject: 'English', relation: 'Class teacher of Anaya Gupta' },
  ],
}

// --- the router -----------------------------------------------------------
function studentOf(url) {
  return url.searchParams.get('student_id') || KABIR
}

/** Returns {status, body} for a request, or null when nothing matches. */
function respond(method, rawUrl) {
  const url = new URL(rawUrl, 'http://x')
  const p = url.pathname
  const sid = studentOf(url)
  const ok = (body) => ({ status: 200, body })
  if (method !== 'GET') {
    if (p.endsWith('/read-all') || p.endsWith('/read')) return ok({ ok: true })
    if (p === '/api/v1/portal/preferences/display') return ok(preferences)
    return ok({ ok: true, id: 'new' })
  }
  switch (p) {
    case '/api/v1/session': return ok(session)
    case '/api/v1/catalog': return ok(catalog)
    case '/api/v1/tour': return ok({ seen: true, role: 'parent', school_name: 'Vivencia', is_first_user: false })
    case '/api/v1/portal/live': return ok({ rev: 'r1' })
    case '/api/v1/profile': return ok({ full_name: 'Priya Gupta' })
    case '/api/v1/portal/students': return ok({ items: children })
    case '/api/v1/portal/students/everywhere': return ok({ items: children.map((c) => ({ ...c, institution_id: 'inst-1', institution_name: 'Vivencia International School', mine: true })) })
    case '/api/v1/portal/summary': return ok(summary(sid))
    case '/api/v1/portal/attendance': return ok({ items: registers[sid] ?? registers[KABIR] })
    case '/api/v1/portal/fees': return ok(fees(sid))
    case '/api/v1/portal/results': return ok(results(sid))
    case '/api/v1/portal/receipts': return ok({ items: receiptRows })
    case '/api/v1/homework': return ok(homework(sid))
    case '/api/v1/communication/circulars': return ok(circulars)
    case '/api/v1/academics/sections': return ok({ items: [] })
    case '/api/v1/portal/notifications': return ok(notifications)
    case '/api/v1/attention': return ok(attention)
    case '/api/v1/me/child-bus': return ok(bus)
    case '/api/v1/portal/messages/teachers': return ok(teachers(sid))
    case '/api/v1/portal/messages': return ok(messages)
    case '/api/v1/portal/remarks': return ok({ items: remarks.items.filter((r) => !url.searchParams.get('student_id') || r.student_id === sid) })
    case '/api/v1/portal/school-life/calendar': return ok(calendar)
    case '/api/v1/portal/school-life/ptm/slots': return ok(ptmSlots)
    case '/api/v1/portal/school-life/ptm/bookings': return ok(ptmBookings)
    case '/api/v1/portal/leave': return ok(leave)
    case '/api/v1/portal/requests': return ok(requests)
    case '/api/v1/portal/requests/types': return ok(requestTypes)
    case '/api/v1/portal/documents': return ok(documents)
    case '/api/v1/portal/pickup': return ok(pickups)
    case '/api/v1/ops/hostel/outpasses': return ok(outpasses)
    case '/api/v1/portal/school-life/gallery': return ok(gallery)
    case '/api/v1/portal/school-life/event-passes': return ok(eventPasses)
    case '/api/v1/portal/academics/iep': return ok(iep(sid))
    case '/api/v1/portal/cafeteria/purchases': return ok(cafeteria)
    case '/api/v1/portal/profile/student-id-card': return ok(studentCard(sid))
    case '/api/v1/portal/profile/parent-id-card': return ok(parentCard)
    case '/api/v1/portal/admission': return ok(admission)
    case '/api/v1/portal/preferences/display': return ok(preferences)
    case '/api/v1/staff-remarks': return ok(staffRemarks)
    case '/api/v1/staff-remarks/teachers': return ok(staffRemarkTeachers)
    case '/api/v1/portal/concerns': return ok({ items: [] })
    default: break
  }
  let m
  if ((m = p.match(/^\/api\/v1\/portal\/receipts\/(.+)$/))) return ok(receiptDetail(m[1]))
  if ((m = p.match(/^\/api\/v1\/portal\/school-life\/gallery\/(.+)$/))) return ok(galleryAlbum(m[1]))
  if (p.startsWith('/api/v1/files/')) return { status: 200, image: true }
  return null
}

module.exports = { respond, parentRole, children, KABIR, ANAYA }
