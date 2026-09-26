import type { Ctx } from '../../router'
import { badRequest, uuid, now } from '../../http'
import {
  allowsValue, coded, ensureCampus, ensurePastYear, errNoAcademicYear, inst, isDate, kindLabels, nextNumber, nullStr,
  trimOrNull, workingYearIn,
} from './common'

/* Port of the write side of internal/api/students_write.go: the request the
   admission form and the CSV importer share, its validation, and upsertStudent. */

export interface StudentWriteRequest {
  admission_no?: string
  first_name: string
  middle_name?: string
  last_name?: string
  date_of_birth?: string
  gender?: string
  blood_group?: string
  medium?: string
  mother_tongue?: string
  religion?: string
  address_line1?: string
  address_line2?: string
  permanent_address?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  emergency_contact_relation?: string
  house_id?: string
  category?: string
  nationality?: string
  aadhaar_last4?: string
  city?: string
  state?: string
  pincode?: string
  apaar_id?: string
  child_info_id?: string
  prior_school?: string
  admission_date?: string
  previous_class?: string
  previous_year?: string
  is_rte?: boolean
  is_cwsn?: boolean
  custom_fields?: Record<string, string>
  section_id?: string
  allow_overflow?: boolean
  academic_year_id?: string
  roll_no?: number
  guardian_name?: string
  guardian_phone?: string
  guardian_email?: string
  guardian_relation?: string
  guardian2_name?: string
  guardian2_phone?: string
  guardian2_email?: string
  guardian2_relation?: string
  guardian3_name?: string
  guardian3_phone?: string
  guardian3_email?: string
  guardian3_relation?: string
  concession_kind?: string
  concession_percent?: string
  concession_amount?: string
  concession_reason?: string
  guardian_occupation?: string
}

export const validGenders = new Set(['male', 'female', 'other'])
export const validCategories = new Set(['general', 'obc', 'sc', 'st', 'ews', 'other'])
const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

/** validate(): the message is what the person typing sees, so it names the field. */
export function validateStudent(req: StudentWriteRequest): string | null {
  if (s(req.first_name).trim() === '') return 'first_name is required'
  if (req.gender && !validGenders.has(req.gender)) return 'gender must be male, female or other'
  if (req.date_of_birth && !isDate(req.date_of_birth)) return 'date_of_birth must be YYYY-MM-DD'
  if (req.apaar_id && req.apaar_id.length !== 12) return 'apaar_id must be 12 digits'
  if (req.pincode && req.pincode.length !== 6) return 'pincode must be 6 digits'
  if (req.category && !validCategories.has(req.category)) return 'category must be general, obc, sc, st, ews or other'
  if (req.aadhaar_last4) {
    if (req.aadhaar_last4.length !== 4) return 'record only the LAST FOUR digits of the Aadhaar number'
    if (!/^\d{4}$/.test(req.aadhaar_last4)) return 'the Aadhaar last four must be digits'
  }
  const cf = req.custom_fields ?? {}
  if (Object.keys(cf).length > 40) return "that is more extra fields than one child's record should carry"
  for (const [k, v] of Object.entries(cf)) {
    if (k.trim() === '') return 'an extra field needs a name'
    if (k.length > 60 || s(v).length > 500) return "keep an extra field's name under 60 characters and its value under 500"
  }
  return null
}

/** checkVocabulary: the lists a school extends for itself. */
export async function checkVocabulary(c: Ctx, req: StudentWriteRequest): Promise<void> {
  for (const [kind, value] of [
    ['medium', s(req.medium).trim().toLowerCase()], ['blood_group', s(req.blood_group).trim()],
    ['mother_tongue', s(req.mother_tongue).trim()], ['religion', s(req.religion).trim()],
  ] as const) {
    if (!(await allowsValue(c, kind, value))) {
      throw badRequest(`that is not one of your ${kindLabels[kind]}. Add it to the list first, then choose it`)
    }
  }
}

export function normaliseRelation(v: string): string {
  switch (v.trim().toLowerCase()) {
    case 'father': case 'f': case 'dad': case 'papa': return 'father'
    case 'mother': case 'm': case 'mom': case 'mum': case 'mummy': return 'mother'
    case '': return 'guardian'
    case 'other': return 'other'
    default: return 'guardian'
  }
}

const concessionKinds = ['scholarship', 'sibling', 'staff_ward', 'rte', 'merit', 'other', 'full_payment']
const blankConcession = new Set(['no', 'none', 'nil', 'na', 'n/a', '-', '--', 'full fee', 'regular'])

export class SectionFullError extends Error { constructor(msg: string) { super(msg) } }

export interface UpsertPlan {
  studentId: string
  admissionNo: string
  /** True when this admission number was not on file before. */
  created: boolean
  stmts: D1PreparedStatement[]
}

/**
 * upsertStudent: the reads happen up front, the writes are returned as one
 * list of statements so the caller runs them in a single batch (or, for the
 * importer, one batch for the whole file).
 */
export async function planUpsertStudent(c: Ctx, req: StudentWriteRequest): Promise<UpsertPlan> {
  const instId = inst(c)
  const campus = await ensureCampus(c)
  let admissionNo = s(req.admission_no).trim()
  if (admissionNo === '') admissionNo = (await nextNumber(c, 'admission')).text

  const existing = await c.db.prepare(`SELECT id, apaar_id FROM students WHERE institution_id = ? AND admission_no = ?`)
    .bind(instId, admissionNo).first<{ id: string; apaar_id: string | null }>()
  const studentId = existing?.id ?? uuid()
  const stmts: D1PreparedStatement[] = []
  const ts = now()

  const apaar = trimOrNull(req.apaar_id)
  if (apaar) {
    // students_apaar_id was a unique index in Postgres; D1 has none, so the refusal is made here.
    const clash = await c.db.prepare(`SELECT 1 AS ok FROM students WHERE apaar_id = ? AND id <> ?`).bind(apaar, studentId).first()
    if (clash) throw coded(409, 'apaar_already_used', 'that APAAR ID is already assigned to another student')
  }

  const customJSON = req.custom_fields && Object.keys(req.custom_fields).length > 0 ? JSON.stringify(req.custom_fields) : null
  const cols = {
    first_name: req.first_name, middle_name: nullStr(req.middle_name), last_name: nullStr(req.last_name),
    date_of_birth: nullStr(req.date_of_birth), gender: nullStr(req.gender), blood_group: nullStr(req.blood_group),
    medium: nullStr(s(req.medium).toLowerCase()), mother_tongue: nullStr(req.mother_tongue), religion: nullStr(req.religion),
    address_line1: nullStr(req.address_line1), city: nullStr(req.city), state: nullStr(req.state), pincode: nullStr(req.pincode),
    apaar_id: apaar, child_info_id: nullStr(req.child_info_id), prior_school: nullStr(req.prior_school),
    is_rte: req.is_rte ? 1 : 0, is_cwsn: req.is_cwsn ? 1 : 0, address_line2: nullStr(req.address_line2),
    category: nullStr(req.category), nationality: nullStr(req.nationality), aadhaar_last4: nullStr(req.aadhaar_last4),
    house_id: nullStr(req.house_id), permanent_address: nullStr(req.permanent_address),
    emergency_contact_name: nullStr(req.emergency_contact_name), emergency_contact_phone: nullStr(req.emergency_contact_phone),
    emergency_contact_relation: nullStr(req.emergency_contact_relation), admission_date: nullStr(req.admission_date),
  }

  if (existing) {
    stmts.push(c.db.prepare(`
      UPDATE students SET first_name = ?, middle_name = ?, last_name = ?, date_of_birth = ?, gender = ?, blood_group = ?,
             medium = ?, mother_tongue = ?, religion = ?, address_line1 = ?, city = ?, state = ?, pincode = ?,
             apaar_id = COALESCE(?, apaar_id), child_info_id = COALESCE(?, child_info_id), prior_school = ?,
             is_rte = ?, is_cwsn = ?, address_line2 = ?, category = ?, nationality = COALESCE(?, 'Indian'), aadhaar_last4 = ?,
             custom_fields = json_patch(custom_fields, COALESCE(?, '{}')),
             house_id = ?, permanent_address = ?, emergency_contact_name = ?, emergency_contact_phone = ?,
             emergency_contact_relation = ?, admission_date = COALESCE(?, admission_date), updated_at = ?
       WHERE id = ?`).bind(
      cols.first_name, cols.middle_name, cols.last_name, cols.date_of_birth, cols.gender, cols.blood_group,
      cols.medium, cols.mother_tongue, cols.religion, cols.address_line1, cols.city, cols.state, cols.pincode,
      cols.apaar_id, cols.child_info_id, cols.prior_school, cols.is_rte, cols.is_cwsn, cols.address_line2, cols.category,
      cols.nationality, cols.aadhaar_last4, customJSON, cols.house_id, cols.permanent_address, cols.emergency_contact_name,
      cols.emergency_contact_phone, cols.emergency_contact_relation, cols.admission_date, ts, studentId))
  } else {
    stmts.push(c.db.prepare(`
      INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, middle_name, last_name, date_of_birth, gender,
             blood_group, medium, mother_tongue, religion, address_line1, city, state, pincode, apaar_id, child_info_id,
             prior_school, is_rte, is_cwsn, address_line2, category, nationality, aadhaar_last4, custom_fields, house_id,
             permanent_address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation, admission_date,
             status, person_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'Indian'), ?, COALESCE(?, '{}'), ?,
              ?, ?, ?, ?, COALESCE(?, ?), 'active', ?, ?, ?)`).bind(
      studentId, instId, campus, admissionNo, cols.first_name, cols.middle_name, cols.last_name, cols.date_of_birth, cols.gender,
      cols.blood_group, cols.medium, cols.mother_tongue, cols.religion, cols.address_line1, cols.city, cols.state, cols.pincode,
      cols.apaar_id, cols.child_info_id, cols.prior_school, cols.is_rte, cols.is_cwsn, cols.address_line2, cols.category,
      cols.nationality, cols.aadhaar_last4, customJSON, cols.house_id, cols.permanent_address, cols.emergency_contact_name,
      cols.emergency_contact_phone, cols.emergency_contact_relation, cols.admission_date, indiaTodayFast(), await freshPersonCode(c), ts, ts))
  }

  // Placement.
  const sectionId = s(req.section_id).trim()
  if (sectionId !== '') {
    let yearId: string
    try { yearId = await workingYearIn(c, s(req.academic_year_id)) } catch { throw errNoAcademicYear() }
    const sec = await c.db.prepare(`
      SELECT c.name || '-' || s.name AS name, s.class_id, s.capacity,
             (SELECT count(*) FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active' AND e.student_id <> ?) AS taken
        FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).bind(studentId, sectionId)
      .first<{ name: string; class_id: string; capacity: number; taken: number }>()
    if (!sec) throw new Error('no such section')
    if (!req.allow_overflow && sec.capacity > 0 && sec.taken >= sec.capacity) {
      throw new SectionFullError(`section is full: ${sec.name} is full at ${sec.taken} of ${sec.capacity}`)
    }
    const rollNo = req.roll_no && req.roll_no > 0 ? req.roll_no : null
    if (rollNo !== null) {
      // enrollments_roll_no_unique in Postgres; said here in words instead.
      const used = await c.db.prepare(`SELECT 1 AS ok FROM enrollments WHERE section_id = ? AND roll_no = ? AND student_id <> ?`)
        .bind(sectionId, rollNo, studentId).first()
      if (used) throw coded(409, 'roll_no_taken',
        'another child in that section already has this roll number. Use a different one, or leave it blank and it will be left unset.')
    }
    const active = await c.db.prepare(`SELECT id FROM enrollments WHERE student_id = ? AND academic_year_id = ? AND status = 'active'`)
      .bind(studentId, yearId).first<{ id: string }>()
    if (active) {
      stmts.push(c.db.prepare(`UPDATE enrollments SET section_id = ?, class_id = ?, roll_no = COALESCE(?, roll_no), status = 'active' WHERE id = ?`)
        .bind(sectionId, sec.class_id, rollNo, active.id))
    } else {
      stmts.push(c.db.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).bind(uuid(), instId, studentId, yearId, sec.class_id, sectionId, rollNo, indiaTodayFast(), ts))
    }
  }

  // Last year's class, where the sheet carries it.
  if (s(req.previous_class) !== '' && s(req.previous_year) !== '') {
    const prevYear = await ensurePastYear(c, campus, s(req.previous_year))
    const prevClass = await c.db.prepare(`SELECT id FROM classes WHERE institution_id = ? AND lower(name) = lower(?)`)
      .bind(instId, req.previous_class).first<{ id: string }>()
    if (prevClass) {
      // enrollments.section_id is NOT NULL in this schema; the Go INSERT wrote none, so the class's first section stands in.
      stmts.push(c.db.prepare(`
        INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, enrolled_on, status, created_at)
        SELECT ?, ?, ?, ?, ?, (SELECT id FROM sections WHERE class_id = ? ORDER BY name LIMIT 1), ?, 'completed', ?
         WHERE NOT EXISTS (SELECT 1 FROM enrollments WHERE student_id = ? AND academic_year_id = ?)
           AND EXISTS (SELECT 1 FROM sections WHERE class_id = ?)`)
        .bind(uuid(), instId, studentId, prevYear, prevClass.id, prevClass.id, indiaTodayFast(), ts, studentId, prevYear, prevClass.id))
    }
  }

  // Both parents, and whoever actually has the child.
  const link = (name: string, phone: string, email: string, relation: string, fallback: string, primary: boolean) => {
    name = name.trim(); phone = phone.trim()
    if (name === '' || phone === '') return
    relation = normaliseRelation(relation === '' ? fallback : relation)
    stmts.push(c.db.prepare(`
      INSERT INTO guardians (id, institution_id, full_name, relation, phone, email, occupation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (institution_id, phone, full_name) DO UPDATE SET relation = excluded.relation,
          email = COALESCE(excluded.email, guardians.email), occupation = COALESCE(excluded.occupation, guardians.occupation)`)
      .bind(uuid(), instId, name, relation, phone, nullStr(email.trim()), nullStr(s(req.guardian_occupation)), ts))
    stmts.push(c.db.prepare(`
      INSERT OR IGNORE INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
      SELECT ?, g.id, ?, ? FROM guardians g WHERE g.institution_id = ? AND g.phone = ? AND g.full_name = ?`)
      .bind(studentId, instId, primary ? 1 : 0, instId, phone, name))
  }
  const haveFirst = s(req.guardian_name).trim() !== '' && s(req.guardian_phone).trim() !== ''
  const haveSecond = s(req.guardian2_name).trim() !== '' && s(req.guardian2_phone).trim() !== ''
  link(s(req.guardian_name), s(req.guardian_phone), s(req.guardian_email), s(req.guardian_relation), 'father', true)
  link(s(req.guardian2_name), s(req.guardian2_phone), s(req.guardian2_email), s(req.guardian2_relation), 'mother', !haveFirst)
  link(s(req.guardian3_name), s(req.guardian3_phone), s(req.guardian3_email), s(req.guardian3_relation), 'guardian', !haveFirst && !haveSecond)

  await planConcession(c, studentId, req, stmts)

  return { studentId, admissionNo, created: !existing, stmts }
}

function indiaTodayFast(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** students_person_code trigger: S + six digits, unique per school. */
async function freshPersonCode(c: Ctx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = 'S' + String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    const taken = await c.db.prepare(`SELECT 1 AS ok FROM students WHERE institution_id = ? AND person_code = ?`).bind(inst(c), candidate).first()
    if (!taken) return candidate
  }
  throw new Error('could not allocate a person code')
}

/** recordConcession: a reduction the family already has, written as approved. */
async function planConcession(c: Ctx, studentId: string, req: StudentWriteRequest, stmts: D1PreparedStatement[]): Promise<void> {
  const kind = s(req.concession_kind).trim().toLowerCase()
  if (kind === '' || blankConcession.has(kind)) return
  if (!concessionKinds.includes(kind)) throw badRequest('concession must be one of ' + concessionKinds.join(', '))
  const percent = s(req.concession_percent).trim()
  const amount = s(req.concession_amount).replace(/,/g, '').trim()
  if (percent === '' && amount === '') throw badRequest('a concession needs a percentage or an amount')
  let amountPaise: number | null = null
  if (amount !== '') {
    const f = Number(amount)
    if (!Number.isFinite(f) || f < 0) throw badRequest('concession_amount must be a number of rupees')
    amountPaise = Math.round(f * 100)
  }
  if (percent !== '') {
    const f = Number(percent)
    if (!Number.isFinite(f) || f <= 0 || f > 100) throw badRequest('concession_percent must be between 1 and 100')
  }
  let reason = s(req.concession_reason).trim()
  reason = reason === '' ? "Carried across when the school's roll was imported" : reason + ' (carried across at import)'
  let yearId: string | null = null
  try { yearId = await workingYearIn(c, '') } catch { yearId = null }
  stmts.push(c.db.prepare(`
    INSERT INTO fee_concessions (id, institution_id, student_id, academic_year_id, kind, percent, amount_paise, reason, status, approved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`)
    .bind(uuid(), inst(c), studentId, yearId, kind, nullStr(percent), amountPaise, reason, now(), now()))
}

// --- CSV import helpers -----------------------------------------------------------

/** A small RFC 4180 reader: quoted fields, doubled quotes, CR/LF line ends. Ragged rows are returned as they are. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false, i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += ch; i++
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

export function splitName(full: string): [string, string, string] {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ['', '', '']
  if (parts.length === 1) return [parts[0], '', '']
  if (parts.length === 2) return [parts[0], '', parts[1]]
  return [parts[0], parts.slice(1, -1).join(' '), parts[parts.length - 1]]
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const pad2 = (n: number) => String(n).padStart(2, '0')
function ymd(y: number, m: number, d: number): string | null {
  if (!(y > 1900 && y < 2100) || m < 1 || m > 12 || d < 1 || d > 31) return null
  const out = `${y}-${pad2(m)}-${pad2(d)}`
  const t = new Date(out + 'T00:00:00Z')
  return t.getUTCMonth() + 1 === m && t.getUTCDate() === d ? out : null
}
/** normaliseDate: the shapes Indian spreadsheets actually contain, to ISO. */
export function normaliseDate(v: string): string {
  v = v.trim()
  if (v === '') return ''
  let m: RegExpMatchArray | null
  if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]) ?? v
  if ((m = v.match(/^(\d{4})\/(\d{2})\/(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]) ?? v
  // dd/mm/yyyy, dd-mm-yyyy, d/m/yyyy, dd.mm.yyyy; then mm/dd/yyyy as Go's layout order tries it.
  if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    return ymd(+m[3], +m[2], +m[1]) ?? ymd(+m[3], +m[1], +m[2]) ?? v
  }
  // 9-Dec-22, 02-Jan-2006, 2 Jan 2006, 2 January 2006
  if ((m = v.match(/^(\d{1,2})[- ]([A-Za-z]+)[- ](\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (mon) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, +m[1]) ?? v
  }
  // Jan 2, 2006
  if ((m = v.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
    if (mon) return ymd(+m[3], mon, +m[2]) ?? v
  }
  return v
}

export function normaliseGender(v: string): string {
  switch (v.trim().toLowerCase()) {
    case 'm': case 'male': case 'boy': case 'b': return 'male'
    case 'f': case 'female': case 'girl': case 'g': return 'female'
    case '': return ''
    default: return v.trim().toLowerCase()
  }
}
export const knownCategory = (v: string) => { const c = v.trim().toLowerCase(); return validCategories.has(c) ? c : '' }
export function sectionLabel(section: string, cls: string): string {
  const sec = section.trim(), k = cls.trim()
  if (sec === '') return ''
  if (k === '' || sec.includes('-')) return sec
  return k + '-' + sec
}
export const isTruthy = (v: string) => ['y', 'yes', 'true', '1'].includes(v.trim().toLowerCase())
export const firstNonEmpty = (...vals: string[]) => vals.find((v) => v !== '') ?? ''
export const relationIfNamed = (name: string, relation: string) => (name.trim() === '' ? '' : relation)
export function aadhaarTail(...vals: string[]): string {
  for (const v of vals) {
    const digits = v.replace(/\D/g, '')
    if (digits.length >= 4) return digits.slice(-4)
  }
  return ''
}
export function withUnmapped(fields: Record<string, string> | undefined, label: string, value: string, keep: boolean) {
  if (!keep || value.trim() === '') return fields
  fields = fields ?? {}
  fields[label] = value.trim()
  return fields
}
export function customValues(rec: string[], cols: Record<string, number>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [label, i] of Object.entries(cols)) {
    if (i < rec.length) { const v = rec[i].trim(); if (v !== '') out[label] = v }
  }
  return Object.keys(out).length ? out : undefined
}

export const IMPORT_TEMPLATE_CSV = [
  'full_name', 'admission_no', 'date_of_birth', 'gender', 'blood_group', 'medium', 'mother_tongue', 'section', 'roll_no',
  'address', 'city', 'state', 'pincode', 'prior_school', 'admission_date', 'previous_class', 'previous_year',
  'guardian_name', 'guardian_relation', 'guardian_phone', 'guardian_email',
].join(',') + '\n' +
  'Meera Menon,ADM0001,14/06/2013,female,B+,english,Malayalam,Class 6-A,1,12 Green Park,Hyderabad,Telangana,500001,St Teresa\'s,' +
  '12/06/2021,Grade 5,2025-26,Suresh Menon,father,9845012345,suresh@example.com\n'
