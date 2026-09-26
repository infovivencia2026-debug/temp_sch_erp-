import type { Ctx } from '../../router'
import type { Identity } from '../../identity'
import { can } from '../../identity'
import { HttpError, conflict, isUUID, now, uuid } from '../../http'
import { school } from '../school'

/* Helpers shared by the exams, hpc, lifecycle, communication, compliance and
   payroll ports. Mirrors internal/scope (the caller's data boundary),
   internal/api/period_close.go (closed years and months), notify() from
   portal_school_life.go and fees.NextNumber. */

// ---------------------------------------------------------------- responses

export const items = <T>(rows: T[]) => ({ items: rows })

/** A side effect that leaves the database (mail, SMS, WhatsApp, queue). Rule 7. */
export const notImplemented = (what: string) => new HttpError(501, `not implemented in the worker: ${what}`)

/** httpx.Error with a code: the body carries {error, code}. */
export const coded = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })

// ---------------------------------------------------------------- sql bits

/** `IN (SELECT value FROM json_each(?))`: ONE bound parameter, bind it with js(ids). D1 caps a statement at
 *  100 parameters, so an id list is never spread. An empty list binds '[]', which matches nothing. */
export function inList(_ids?: readonly unknown[]): string {
  return '(SELECT value FROM json_each(?))'
}

/** The single parameter an inList() binds. */
export const js = (ids: readonly unknown[]): string => JSON.stringify(ids)

/** concat_ws(' ', first, middle, last) for a students/employees alias. */
export const nameOf = (a: string, middle = true) =>
  `TRIM(REPLACE(${a}.first_name || ' ' || ${middle ? `COALESCE(${a}.middle_name,'') || ' ' || ` : ''}COALESCE(${a}.last_name,''), '  ', ' '))`

/** to_char(ts,'YYYY-MM-DD') on an ISO text column. */
export const dateOf = (col: string) => `SUBSTR(${col},1,10)`
/** to_char(ts,'YYYY-MM-DD"T"HH24:MI') on an ISO text column. */
export const minuteOf = (col: string) => `SUBSTR(${col},1,16)`

export const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
export const numOr0 = (v: unknown): number => Number(v ?? 0) || 0
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const trimFloat = (v: number) => String(Number(v.toFixed(10)))

// ---------------------------------------------------------------- time

/** The current moment in India, as a Date whose UTC fields read as IST. */
export function nowIST(): Date {
  return new Date(Date.now() + 5.5 * 3600 * 1000)
}
export const todayIST = () => nowIST().toISOString().slice(0, 10)
export const pad2 = (n: number) => String(n).padStart(2, '0')
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The Indian financial year containing d ("2026-27"). */
export function financialYear(d: Date): string {
  let y = d.getUTCFullYear()
  if (d.getUTCMonth() + 1 < 4) y--
  return `${y}-${pad2((y + 1) % 100)}`
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;')

// ---------------------------------------------------------------- scope

export interface Resolved {
  userId: string
  platformAdmin: boolean
  campusIds: string[]
  departmentIds: string[]
  sectionIds: string[]
  classTeacherOf: string[]
  studentIds: string[]
  teaches: boolean
  allStudents: boolean
  allAttendance: boolean
  anySection: boolean
  allCampuses: boolean
  isClassTeacherOf(sectionId: string): boolean
  ownsStudent(studentId: string): boolean
}

const cache = new WeakMap<Identity, Promise<Resolved>>()

/** Port of scope.Resolve, computed at most once per request. */
export function resolveScope(c: Ctx): Promise<Resolved> {
  let p = cache.get(c.id)
  if (!p) { p = resolveUncached(c); cache.set(c.id, p) }
  return p
}

async function resolveUncached(c: Ctx): Promise<Resolved> {
  const id = c.id
  const r: Resolved = {
    userId: id.userId, platformAdmin: id.platformAdmin,
    campusIds: [], departmentIds: [], sectionIds: [], classTeacherOf: [], studentIds: [],
    teaches: false,
    allStudents: can(id, 'students.read.all'),
    allAttendance: can(id, 'academics.attendance.read.all'),
    anySection: can(id, 'academics.attendance.write.any'),
    allCampuses: false,
    isClassTeacherOf(s) { return this.anySection || this.platformAdmin || this.classTeacherOf.includes(s) },
    ownsStudent(s) { return this.studentIds.includes(s) },
  }
  if (id.platformAdmin) {
    r.allCampuses = r.allStudents = r.allAttendance = r.anySection = true
    return r
  }
  const u = id.userId
  const [campuses, depts, sections, cto, teaches, students] = await c.db.batch([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(u),
    c.db.prepare(`SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?1
                  UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?1
                  UNION SELECT id FROM sections WHERE class_teacher_id = ?1
                  UNION SELECT DISTINCT te.section_id FROM timetable_entries te
                         JOIN employees emp ON emp.user_id = te.teacher_user_id
                        WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?1)`).bind(u),
    c.db.prepare(`SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u),
    c.db.prepare(`SELECT EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.teacher_user_id = ?1)
                      OR EXISTS (SELECT 1 FROM sections s WHERE s.class_teacher_id = ?1) AS t`).bind(u),
    c.db.prepare(`SELECT id FROM students WHERE user_id = ?1
                  UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                   WHERE g.user_id = ?1 AND NOT sg.portal_blocked
                     AND (sg.access_until IS NULL OR sg.access_until >= ?2)`).bind(u, todayIST()),
  ])
  for (const row of campuses.results as { campus_id: string | null }[]) {
    if (row.campus_id === null) r.allCampuses = true
    else r.campusIds.push(row.campus_id)
  }
  r.departmentIds = (depts.results as { id: string }[]).map((x) => x.id)
  r.sectionIds = (sections.results as { id: string }[]).map((x) => x.id)
  r.classTeacherOf = (cto.results as { id: string }[]).map((x) => x.id)
  r.teaches = !!(teaches.results[0] as { t: number } | undefined)?.t
  r.studentIds = (students.results as { id: string }[]).map((x) => x.id)
  return r
}

// ---------------------------------------------------------------- periods

/** requireOpenYear: a write into a closed academic year is a 409 period_closed. */
export async function requireOpenYear(c: Ctx, yearId: string | null): Promise<void> {
  if (!yearId) return
  const row = await c.db.prepare(`SELECT name, closed_at FROM academic_years WHERE id = ?`).bind(yearId)
    .first<{ name: string; closed_at: string | null }>()
  if (row && row.closed_at) throw coded(409, 'period_closed', `The year ${row.name} is closed; ask the principal to reopen it`)
}

/** requireOpenPeriod(kind='month') for the first of a month. */
export async function requireOpenMonth(c: Ctx, year: number, month: number): Promise<void> {
  const key = `${year}-${pad2(month)}`
  const on = `${key}-01`
  const row = await c.db.prepare(`
    SELECT EXISTS (SELECT 1 FROM period_closes WHERE kind = 'month' AND period_key = ?1 AND reopened_at IS NULL) AS m,
           (SELECT name FROM academic_years WHERE closed_at IS NOT NULL AND ?2 BETWEEN starts_on AND ends_on
             ORDER BY starts_on DESC LIMIT 1) AS y`).bind(key, on).first<{ m: number; y: string | null }>()
  if (row?.m) throw coded(409, 'period_closed', `${MONTHS[month - 1]} ${year} is closed; ask the principal to reopen it`)
  if (row?.y) throw coded(409, 'period_closed', `The year ${row.y} is closed; ask the principal to reopen it`)
}

// ---------------------------------------------------------------- notifications

/** The statement notify() ran: one alert per (user, kind, source, student) when a source is named. */
export function notifyStmt(c: Ctx, user: string, student: string | null, kind: string, title: string, body: string,
  link: string, sourceKind: string | null, sourceId: string | null): D1PreparedStatement {
  return c.db.prepare(`
    INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
     WHERE ?9 IS NULL OR NOT EXISTS (
       SELECT 1 FROM notifications n WHERE n.user_id = ?3 AND n.kind = ?5
          AND COALESCE(n.source_id,'') = COALESCE(?10,'') AND COALESCE(n.student_id,'') = COALESCE(?4,'')
          AND n.source_kind IS NOT NULL)`)
    .bind(uuid(), school(c).id, user, student, kind, title, body, link, sourceKind, sourceId, now())
}

// ---------------------------------------------------------------- numbering

/*
Port of fees.NextNumberOn. D1 has no row locks; the counter is advanced with a
conditional UPDATE and retried, which is what serialises two clerks here.
*/
export async function nextNumber(c: Ctx, kind: string, on: Date = nowIST()): Promise<string> {
  const inst = school(c).id
  const defaults: Record<string, string> = { receipt: 'RCPT/', invoice: 'INV/' }
  await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at)
      SELECT ?, ?, ?, ?, 5, 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL)`)
    .bind(uuid(), inst, kind, defaults[kind] ?? '', now(), inst, kind).run()

  for (let attempt = 0; attempt < 5; attempt++) {
    const s = await c.db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format
        FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(inst, kind)
      .first<{ prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }>()
    if (!s) throw new Error(`numbering scheme ${kind} missing`)
    let seq = s.next_value
    let fy = ''
    if (s.reset_yearly) {
      fy = financialYear(on)
      let seed = 1
      if (!s.current_fy || s.current_fy === fy) seed = s.next_value
      else if (kind === 'receipt') {
        const last = await c.db.prepare(`SELECT MAX(receipt_seq) AS n FROM payments WHERE institution_id = ? AND receipt_fy = ?`)
          .bind(inst, fy).first<{ n: number | null }>()
        if (last?.n != null) seed = last.n + 1
      }
      await c.db.prepare(`INSERT OR IGNORE INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?,?,?,?)`)
        .bind(inst, kind, fy, seed).run()
      const fc = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?`)
        .bind(inst, kind, fy).first<{ next_value: number }>()
      seq = fc!.next_value
      const adv = await c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ? + 1 WHERE institution_id = ? AND kind = ? AND fy = ? AND next_value = ?`)
        .bind(seq, inst, kind, fy, seq).run()
      if (!adv.meta.changes) continue
    }
    const text = renderNumber(s.format, s.prefix, fy, seq, s.padding, s.suffix)
    if (!s.reset_yearly) {
      const adv = await c.db.prepare(`UPDATE numbering_schemes SET next_value = ? + 1, last_number = ?, last_issued_at = ?, updated_at = ?
          WHERE institution_id = ? AND kind = ? AND campus_id IS NULL AND next_value = ?`)
        .bind(seq, text, now(), now(), inst, kind, seq).run()
      if (!adv.meta.changes) continue
    } else if (!s.current_fy || s.current_fy <= fy) {
      await c.db.prepare(`UPDATE numbering_schemes SET next_value = ? + 1, current_fy = NULLIF(?,''), last_number = ?, last_issued_at = ?, updated_at = ?
          WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(seq, fy, text, now(), now(), inst, kind).run()
    } else {
      await c.db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ?
          WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(text, now(), now(), inst, kind).run()
    }
    return text
  }
  throw conflict('could not allocate a serial number, try again')
}

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (!format) format = '{prefix}{fy}/{seq}{suffix}'
  if (!fy) for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.replace('{prefix}', prefix).replace('{fy}', fy)
    .replace('{seq}', String(seq).padStart(padding, '0')).replace('{suffix}', suffix)
}

// ---------------------------------------------------------------- misc

export const uuidsOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(isUUID) : []

/** Indian grouping (crore/lakh) number words, port of fees.NumberInWords. */
export function numberInWords(n: number): string {
  if (n === 0) return 'Zero'
  if (n < 0) return 'Minus ' + indianWords(-n)
  return indianWords(n)
}
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function twoDigits(n: number): string {
  if (n === 0) return ''
  if (n < 20) return ONES[n]
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')
}
function threeDigits(n: number): string {
  const parts: string[] = []
  const h = Math.floor(n / 100)
  if (h > 0) parts.push(ONES[h] + ' Hundred')
  const t = twoDigits(n % 100)
  if (t) parts.push(t)
  return parts.join(' ')
}
function indianWords(n: number): string {
  if (n >= 1_00_00_000 * 100) return String(n)
  const parts: string[] = []
  const crore = Math.floor(n / 1_00_00_000)
  if (crore > 0) { parts.push(threeDigits(crore) + ' Crore'); n %= 1_00_00_000 }
  const lakh = Math.floor(n / 1_00_000)
  if (lakh > 0) { parts.push(twoDigits(lakh) + ' Lakh'); n %= 1_00_000 }
  const thousand = Math.floor(n / 1000)
  if (thousand > 0) { parts.push(twoDigits(thousand) + ' Thousand'); n %= 1000 }
  const rest = threeDigits(n)
  if (rest) parts.push(rest)
  return parts.join(' ')
}

/** Domain-separated HMAC, port of auth.Hasher.Sign: base32 of HMAC(pepper, purpose||0||message), "xxxxx-xxxxx". */
export async function sign(pepper: string, purpose: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const enc = new TextEncoder()
  const p = enc.encode(purpose), m = enc.encode(message)
  const data = new Uint8Array(p.length + 1 + m.length)
  data.set(p, 0); data[p.length] = 0; data.set(m, p.length + 1)
  const sum = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  const b32 = base32(sum)
  return b32.slice(0, 5) + '-' + b32.slice(5, 10)
}
function base32(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31]
  return out
}
