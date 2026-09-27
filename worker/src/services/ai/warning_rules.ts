/* Early-warning rules: plain arithmetic over rows the nightly job reads.
   No I/O and no AI here, so every threshold is testable and every flag
   carries the numbers that raised it. The AI only ever rewrites `reason`
   into a friendlier sentence (services/ai/warnings.ts); the decision to
   raise a flag is always one of these rules. */

export type Severity = 'low' | 'medium' | 'high'
export type OwnerRole = 'class_teacher' | 'accounts' | 'principal'
export type Rule = 'attendance_drop' | 'consecutive_absence' | 'marks_falling' | 'fee_risk' | 'staff_absence' | 'unmarked_registers'
export type Evidence = Record<string, string | number | string[]>

export interface Flag {
  rule: Rule
  subject_kind: 'student' | 'employee' | 'section'
  subject_id: string
  subject_name: string
  student_id?: string | null
  section_id?: string | null
  owner_user_id?: string | null
  severity: Severity
  owner_role: OwnerRole
  evidence: Evidence
  reason: string
  next_step: string
}

export const THRESHOLDS = {
  recentDays: 21,          // "last 3 weeks"
  minRecentMarked: 5,      // days marked in the window before a % means anything
  dropPoints: 10,          // recent % this far below the term % raises a flag...
  recentBelow: 85,         // ...when recent is also under this
  consecutiveAbsent: 3,
  marksDropPoints: 15,     // percentage points, latest exam vs the one before, per subject
  feeOverdueDays: 30,
  staffWindowDays: 30,
  staffAbsences: 4,
  staffEdgeDays: 3,        // absences on Mondays/Fridays (or next to a holiday) in the window
  registerWindowDays: 14,
  registerMissing: 3,
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0)
const ms = (d: string) => Date.parse(d.slice(0, 10) + 'T00:00:00Z')
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86_400_000)
const rupees = (p: number) => '₹' + Math.round(p / 100).toLocaleString('en-IN')

// ---- students: attendance -----------------------------------------------------

export interface StudentRef { student_id: string; name: string; section_id: string | null; section_name?: string; class_teacher_id?: string | null }
export interface AttendanceMark { on_date: string; status: string }

const counts = (s: string) => s !== 'holiday' && s !== 'leave'
const present = (s: string) => s === 'present' || s === 'late' || s === 'half_day'

export function attendanceFlags(st: StudentRef, marks: AttendanceMark[], today: string): Flag[] {
  const days = marks.filter((m) => counts(m.status)).sort((a, b) => a.on_date.localeCompare(b.on_date))
  if (days.length === 0) return []
  const out: Flag[] = []
  const base = { subject_kind: 'student' as const, subject_id: st.student_id, subject_name: st.name, student_id: st.student_id,
    section_id: st.section_id, owner_user_id: st.class_teacher_id ?? null, owner_role: 'class_teacher' as const }

  const recent = days.filter((m) => daysBetween(m.on_date, today) < THRESHOLDS.recentDays)
  const termPct = pct(days.filter((m) => present(m.status)).length, days.length)
  const recentPresent = recent.filter((m) => present(m.status)).length
  const recentPct = pct(recentPresent, recent.length)
  if (recent.length >= THRESHOLDS.minRecentMarked && termPct - recentPct >= THRESHOLDS.dropPoints && recentPct < THRESHOLDS.recentBelow) {
    const severity: Severity = recentPct < 60 ? 'high' : termPct - recentPct >= 20 ? 'high' : 'medium'
    out.push({ ...base, rule: 'attendance_drop', severity,
      evidence: { recent_pct: recentPct, term_pct: termPct, recent_days: recent.length, recent_present: recentPresent, term_days: days.length },
      reason: `${st.name}'s attendance fell to ${recentPct}% over the last 3 weeks (${recentPresent} of ${recent.length} days), against ${termPct}% for the term.`,
      next_step: 'Call the parents to ask what has changed, and note the reason on the record.' })
  }

  let run = 0
  let since = ''
  for (let i = days.length - 1; i >= 0 && days[i].status === 'absent'; i--) { run++; since = days[i].on_date }
  if (run >= THRESHOLDS.consecutiveAbsent) {
    out.push({ ...base, rule: 'consecutive_absence', severity: run >= 5 ? 'high' : 'medium',
      evidence: { consecutive_absent: run, since, last_marked: days[days.length - 1].on_date },
      reason: `${st.name} has been absent ${run} school days in a row, since ${since}.`,
      next_step: 'Phone home today; if there is no answer, ask the office to follow up.' })
  }
  return out
}

// ---- students: marks ------------------------------------------------------------

export interface MarkRow { subject: string; exam: string; exam_date: string; obtained: number; max: number; pass?: number | null }

export function marksFlags(st: StudentRef, rows: MarkRow[]): Flag[] {
  const bySubject = new Map<string, MarkRow[]>()
  for (const r of rows) {
    if (!(r.max > 0)) continue
    const l = bySubject.get(r.subject) ?? []
    l.push(r)
    bySubject.set(r.subject, l)
  }
  const falls: { subject: string; latest: number; previous: number; drop: number; failing: boolean; exam: string; prevExam: string }[] = []
  for (const [subject, l] of bySubject) {
    l.sort((a, b) => a.exam_date.localeCompare(b.exam_date))
    if (l.length < 2) continue
    const a = l[l.length - 2], b = l[l.length - 1]
    const previous = pct(a.obtained, a.max), latest = pct(b.obtained, b.max)
    const drop = Math.round((previous - latest) * 10) / 10
    const failing = b.pass != null && b.obtained < b.pass
    if (drop >= THRESHOLDS.marksDropPoints) falls.push({ subject, latest, previous, drop, failing, exam: b.exam, prevExam: a.exam })
  }
  if (falls.length === 0) return []
  falls.sort((x, y) => y.drop - x.drop)
  const worst = falls[0]
  const severity: Severity = falls.some((f) => f.failing) || worst.drop >= 25 || falls.length >= 3 ? 'high' : 'medium'
  const list = falls.map((f) => `${f.subject} ${f.previous}% → ${f.latest}%`)
  return [{ rule: 'marks_falling', subject_kind: 'student', subject_id: st.student_id, subject_name: st.name, student_id: st.student_id,
    section_id: st.section_id, owner_user_id: st.class_teacher_id ?? null, owner_role: 'class_teacher', severity,
    evidence: { subjects: list, worst_subject: worst.subject, worst_drop_points: worst.drop, latest_exam: worst.exam, previous_exam: worst.prevExam,
      failing_subjects: falls.filter((f) => f.failing).length },
    reason: `${st.name}'s marks fell in ${falls.length === 1 ? worst.subject : falls.length + ' subjects'} between ${worst.prevExam} and ${worst.exam}: ${list.join('; ')}.`,
    next_step: 'Talk to the subject teacher' + (falls.length > 1 ? 's' : '') + ' and plan a remedial check before the next test.' }]
}

// ---- students: fees ----------------------------------------------------------------

export interface FeeFacts { overdue_paise: number; oldest_due_on: string | null; overdue_invoices: number; last_paid_on: string | null; payments_last_year: number; late_payments_last_year: number }

export function feeFlags(st: StudentRef, f: FeeFacts, today: string): Flag[] {
  if (f.overdue_paise <= 0 || !f.oldest_due_on) return []
  const daysOverdue = daysBetween(f.oldest_due_on, today)
  if (daysOverdue < THRESHOLDS.feeOverdueDays) return []
  const sinceLastPaid = f.last_paid_on ? daysBetween(f.last_paid_on, today) : null
  const habituallyLate = f.payments_last_year > 0 && f.late_payments_last_year / f.payments_last_year >= 0.5
  const severity: Severity = daysOverdue >= 90 || sinceLastPaid === null || sinceLastPaid >= 120 ? 'high' : habituallyLate || daysOverdue >= 60 ? 'medium' : 'low'
  const evidence: Evidence = { overdue_rupees: Math.round(f.overdue_paise / 100), days_overdue: daysOverdue, overdue_invoices: f.overdue_invoices,
    payments_last_year: f.payments_last_year, late_payments_last_year: f.late_payments_last_year }
  if (f.last_paid_on) evidence.last_paid_on = f.last_paid_on
  const history = f.last_paid_on ? `last paid on ${f.last_paid_on}` : 'no payment on record'
  return [{ rule: 'fee_risk', subject_kind: 'student', subject_id: st.student_id, subject_name: st.name, student_id: st.student_id,
    section_id: st.section_id, owner_role: 'accounts', severity, evidence,
    reason: `${rupees(f.overdue_paise)} is overdue for ${st.name} across ${f.overdue_invoices} invoice${f.overdue_invoices === 1 ? '' : 's'}, the oldest ${daysOverdue} days late; ${history}${habituallyLate ? ', and most payments this year came late' : ''}.`,
    next_step: severity === 'high' ? 'Call the family to agree a payment plan; check for hardship before sending reminders.' : 'Send a polite reminder with the amount and due dates.' }]
}

// ---- staff ---------------------------------------------------------------------

export interface StaffRef { user_id: string; name: string }
export interface StaffDay { on_date: string; status: string }

export function staffFlags(s: StaffRef, days: StaffDay[], today: string): Flag[] {
  const absent = days.filter((d) => d.status === 'absent' && daysBetween(d.on_date, today) < THRESHOLDS.staffWindowDays)
  if (absent.length === 0) return []
  const edge = absent.filter((d) => { const w = new Date(ms(d.on_date)).getUTCDay(); return w === 1 || w === 5 }).length
  if (absent.length < THRESHOLDS.staffAbsences && edge < THRESHOLDS.staffEdgeDays) return []
  const pattern = edge >= THRESHOLDS.staffEdgeDays
  return [{ rule: 'staff_absence', subject_kind: 'employee', subject_id: s.user_id, subject_name: s.name, owner_role: 'principal',
    severity: absent.length >= 6 || (pattern && absent.length >= 4) ? 'high' : 'medium',
    evidence: { absences_30d: absent.length, monday_friday_absences: edge, dates: absent.map((d) => d.on_date).sort() },
    reason: `${s.name} was absent ${absent.length} day${absent.length === 1 ? '' : 's'} in the last 30${pattern ? `, ${edge} of them on a Monday or Friday` : ''}.`,
    next_step: 'Have a private word to check on wellbeing and workload; confirm leave is being applied for.' }]
}

// ---- registers --------------------------------------------------------------------

export interface SectionRef { section_id: string; name: string; class_teacher_id: string | null; class_teacher_name?: string | null }

/** schoolDays: days in the window when the school marked any register at all. */
export function registerFlags(s: SectionRef, schoolDays: string[], markedDays: string[]): Flag[] {
  if (schoolDays.length === 0) return []
  const marked = new Set(markedDays)
  const missing = schoolDays.filter((d) => !marked.has(d)).sort()
  if (missing.length < THRESHOLDS.registerMissing) return []
  return [{ rule: 'unmarked_registers', subject_kind: 'section', subject_id: s.section_id, subject_name: s.name, section_id: s.section_id,
    owner_user_id: s.class_teacher_id, owner_role: 'principal', severity: missing.length >= 6 ? 'high' : 'medium',
    evidence: { missing_days: missing.length, school_days: schoolDays.length, dates: missing.slice(-10) },
    reason: `${s.name}'s register was not marked on ${missing.length} of the last ${schoolDays.length} school days.`,
    next_step: `Remind ${s.class_teacher_name || 'the class teacher'} to mark the missing days (they can be back-filled).` }]
}

/** A stable key for an evidence object: the explanation cache is keyed on it. */
export function evidenceKey(rule: string, e: Evidence): string {
  const keys = Object.keys(e).sort()
  return rule + ':' + keys.map((k) => k + '=' + JSON.stringify(e[k])).join('&')
}
