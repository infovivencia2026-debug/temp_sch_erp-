import type { Router } from '../../router'
import { collect } from '../fees/counter'
import { isBatchGuardFailure } from '../fees/common'
import type { Ctx } from '../../router'
import { HttpError, badRequest, forbidden, notFound, ok, uuid, uuidParam, now } from '../../http'
import { can } from '../../identity'
import { requireInstitution, instId, nullStr, ensureCampus, workingYearId, classLevelFromName, CLASS_LEVEL_FLOOR, CLASS_LEVEL_CEILING,
  appointEmployee, PhoneInUse, endFamilyAccess, todayIndia, istToUTC, isClock, str } from './common'
import { registerImportSpecsExtra } from './imports_extra'

/* Port of bulk_import.go: the shared CSV importer, its history and undo.

   Dry run by default, ?commit=true writes. Rows are validated (Check),
   checked against the database (Verify) and then written one at a time.
   Postgres wrapped each row in a savepoint; D1 has none, so a row that
   fails part way through its own statements can leave what it wrote
   before the failure. The dry run exists to make that rare. */

export type Row = Record<string, string>

export interface CreatedRow { entity: string; id: string }

export interface SheetFacts { from: string; to: string; year: string; exam: string; class: string; maxMarks: number }

export class ImportCtx {
  classes = new Map<string, string>()
  sections = new Map<string, string>()
  teachers = new Map<string, string>()
  periods: Map<string, string> | null = null
  devices = new Map<string, string>()
  punchSeen = new Set<string>()
  pastYears = new Map<string, string>()
  pastExams = new Map<string, string>()
  created: CreatedRow[] = []
  year: string | null = null
  constructor(public c: Ctx, public inst: string, public campus: string, public sheet: SheetFacts, public subjectCols: Record<string, string>) {}

  get db(): D1Database { return this.c.db }

  noteCreated(entity: string, id: string, inserted: boolean): void {
    if (inserted) this.created.push({ entity, id })
  }
  forgetCaches(): void {
    this.classes.clear(); this.sections.clear(); this.teachers.clear(); this.periods = null
    this.pastYears.clear(); this.pastExams.clear()
  }

  async classID(name: string): Promise<string> {
    const key = name.trim().toLowerCase()
    const hit = this.classes.get(key)
    if (hit) return hit
    const row = await this.db.prepare(`SELECT id FROM classes WHERE institution_id = ? AND lower(name) = ?`).bind(this.inst, key).first<{ id: string }>()
    if (!row) throw new Error(`no class called "${name}". Create the classes first`)
    this.classes.set(key, row.id)
    return row.id
  }

  async sectionIDFor(className: string, sectionName: string): Promise<string> {
    const classId = await this.classID(className)
    const key = className.trim().toLowerCase() + '/' + sectionName.trim().toLowerCase()
    const hit = this.sections.get(key)
    if (hit) return hit
    const row = await this.db.prepare(`SELECT id FROM sections WHERE institution_id = ? AND class_id = ? AND lower(name) = ? LIMIT 1`)
      .bind(this.inst, classId, sectionName.trim().toLowerCase()).first<{ id: string }>()
    if (!row) throw new Error(`${className} has no section "${sectionName}". Create the sections first`)
    this.sections.set(key, row.id)
    return row.id
  }

  /** The member of staff a sheet names: by email, by staff code, then by name (refused when ambiguous). */
  async teacherByEmail(who: string): Promise<string> {
    const key = who.trim().toLowerCase()
    if (key === '') throw new Error('no teacher named')
    const hit = this.teachers.get(key)
    if (hit) return hit
    let row = await this.db.prepare(`SELECT id FROM users WHERE institution_id = ? AND email = ?`).bind(this.inst, key).first<{ id: string }>()
    if (!row) {
      row = await this.db.prepare(`SELECT user_id AS id FROM employees WHERE institution_id = ? AND lower(employee_code) = ? AND user_id IS NOT NULL`).bind(this.inst, key).first<{ id: string }>()
    }
    if (!row) {
      const n = await this.db.prepare(`SELECT COUNT(*) AS n FROM employees e WHERE e.institution_id = ? AND e.user_id IS NOT NULL
          AND lower(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, ''))) = ?`).bind(this.inst, key).first<{ n: number }>()
      if ((n?.n ?? 0) > 1) throw new Error(`${n!.n} members of staff are called "${who}", so this row could mean either. Use their staff code or their email instead`)
      row = await this.db.prepare(`SELECT user_id AS id FROM employees e WHERE e.institution_id = ? AND e.user_id IS NOT NULL
          AND lower(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, ''))) = ?`).bind(this.inst, key).first<{ id: string }>()
    }
    if (!row) {
      throw new Error(`no member of staff called "${who}", by email, staff code or name. Import the staff first. Somebody with no email has a record but no account, so nothing can be assigned to them`)
    }
    this.teachers.set(key, row.id)
    return row.id
  }

  async periodID(want: string): Promise<string> {
    want = want.trim()
    if (want === '') throw new Error('period is required')
    if (!this.periods) {
      this.periods = new Map()
      const rows = await this.db.prepare(`SELECT id, name, sequence FROM periods WHERE institution_id = ?`).bind(this.inst).all<{ id: string; name: string; sequence: number }>()
      for (const p of rows.results) {
        for (const k of [p.name.trim().toLowerCase(), String(p.sequence), 'p' + p.sequence, 'period ' + p.sequence]) {
          if (!this.periods.has(k)) this.periods.set(k, p.id)
        }
      }
    }
    const id = this.periods.get(want.toLowerCase())
    if (!id) throw new Error(`no period called "${want}" -- set the school day up first, or use the period number`)
    return id
  }

  workingYearID(): string {
    if (!this.year) throw new Error('create an academic year before loading a timetable')
    return this.year
  }

  async bellScheduleID(name: string): Promise<string> {
    const key = name.trim().toLowerCase()
    const hit = this.pastYears.get('bell:' + key)
    if (hit) return hit
    let id: string
    if (key === '') {
      const row = await this.db.prepare(`SELECT id FROM bell_schedules WHERE institution_id = ? ORDER BY is_default DESC, created_at LIMIT 1`).bind(this.inst).first<{ id: string }>()
      if (row) id = row.id
      else {
        id = uuid()
        await this.db.prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, 'Standard day', 1, ?)`).bind(id, this.inst, this.campus, now()).run()
      }
    } else {
      const row = await this.db.prepare(`SELECT id FROM bell_schedules WHERE institution_id = ? AND lower(name) = ?`).bind(this.inst, key).first<{ id: string }>()
      if (row) id = row.id
      else {
        id = uuid()
        await this.db.prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)`).bind(id, this.inst, this.campus, name.trim(), now()).run()
      }
    }
    this.pastYears.set('bell:' + key, id)
    return id
  }

  /** A past academic year by the name a school writes, created when genuinely new and never current. */
  async pastYearID(name: string): Promise<string> {
    const key = name.trim().toLowerCase().replace(/ /g, '')
    const hit = this.pastYears.get(key)
    if (hit) return hit
    const found = await this.db.prepare(`SELECT id FROM academic_years WHERE institution_id = ? AND replace(lower(name), ' ', '') = ?`).bind(this.inst, key).first<{ id: string }>()
    let id: string
    if (found) id = found.id
    else {
      const start = key.length >= 4 ? Number(key.slice(0, 4)) : 0
      if (!start) throw new Error(`cannot read a year from "${name}". Write it as 2025-26`)
      id = uuid()
      await this.db.prepare(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
        .bind(id, this.inst, this.campus, name.trim(), `${start}-06-01`, `${start + 1}-03-31`, now()).run()
    }
    this.pastYears.set(key, id)
    return id
  }

  async pastExamID(year: string, name: string): Promise<string> {
    const key = year + '|' + name.trim().toLowerCase()
    const hit = this.pastExams.get(key)
    if (hit) return hit
    const found = await this.db.prepare(`SELECT id FROM exams WHERE institution_id = ? AND academic_year_id = ? AND lower(name) = lower(?)`).bind(this.inst, year, name.trim()).first<{ id: string }>()
    let id: string
    if (found) id = found.id
    else {
      id = uuid()
      await this.db.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?, 'term', ?)`)
        .bind(id, this.inst, this.campus, year, name.trim(), now()).run()
    }
    this.pastExams.set(key, id)
    return id
  }

  async designationID(name: string): Promise<string> {
    const n = name.trim()
    if (n === '') return ''
    const row = await this.db.prepare(`SELECT id FROM designations WHERE institution_id = ? AND lower(name) = lower(?)`).bind(this.inst, n).first<{ id: string }>()
    if (row) return row.id
    const id = uuid()
    await this.db.prepare(`INSERT INTO designations (id, institution_id, name) VALUES (?, ?, ?)`).bind(id, this.inst, n).run()
    return id
  }

  async departmentID(name: string): Promise<string> {
    const n = name.trim()
    if (n === '') return ''
    const row = await this.db.prepare(`SELECT id FROM departments WHERE institution_id = ? AND lower(name) = lower(?)`).bind(this.inst, n).first<{ id: string }>()
    if (row) return row.id
    const id = uuid()
    await this.db.prepare(`INSERT INTO departments (id, institution_id, name) VALUES (?, ?, ?)`).bind(id, this.inst, n).run()
    return id
  }

  async deviceBySerial(serial: string): Promise<string> {
    const key = serial.trim().toLowerCase()
    if (key === '') throw new Error('device_serial is required: it is the serial number printed on the reader')
    const hit = this.devices.get(key)
    if (hit) return hit
    const row = await this.db.prepare(`SELECT id FROM biometric_devices WHERE institution_id = ? AND lower(serial) = ?`).bind(this.inst, key).first<{ id: string }>()
    if (!row) {
      throw new Error(`no biometric reader is registered with serial "${serial.trim()}". Add it under Settings, Biometric devices, using the serial printed on the machine, then upload this file again`)
    }
    this.devices.set(key, row.id)
    return row.id
  }

  /** The sections named beside a class on the same row (writeSections). */
  async writeSections(row: Row, classId: string): Promise<void> {
    const list = str(row.sections).trim()
    if (list === '') return
    let capacity = 40
    const capText = str(row.capacity).replace(/,/g, '').trim()
    if (capText !== '') { const n = Number(capText); if (Number.isInteger(n) && n > 0) capacity = n }
    let strength: number | null = null
    const stText = str(row.strength).replace(/,/g, '').trim()
    if (stText !== '') { const n = Number(stText); if (Number.isInteger(n) && n >= 0) strength = n }
    const yearId = await workingYearId(this.c)
    if (!yearId) throw new Error('open the academic year before importing sections')
    for (const raw of list.split(/[,;/]/)) {
      const name = raw.trim()
      if (name === '') continue
      const existing = await this.db.prepare(`SELECT id FROM sections WHERE class_id = ? AND academic_year_id = ? AND name = ?`).bind(classId, yearId, name).first<{ id: string }>()
      if (existing) {
        await this.db.prepare(`UPDATE sections SET capacity = ?, stated_strength = COALESCE(?, stated_strength) WHERE id = ?`).bind(capacity, strength, existing.id).run()
        continue
      }
      const id = uuid()
      await this.db.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, capacity, stated_strength, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, this.inst, this.campus, classId, yearId, name, capacity, strength, now()).run()
      this.noteCreated('sections', id, true)
    }
  }
}

export interface ImportSpec {
  perm: string
  columns: string[]
  required: string[]
  identity?: string
  sample: string[]
  check?: (row: Row) => void
  skip?: (row: Row) => boolean
  verify?: (ctx: ImportCtx, row: Row) => Promise<void>
  write: (ctx: ImportCtx, row: Row) => Promise<void>
}

/* --- reading cells the way the office writes them --------------------------- */

export const isYes = (v: string): boolean => ['y', 'yes', 'true', '1'].includes(v.trim().toLowerCase())
export const isNo = (v: string): boolean => ['n', 'no', 'false', '0'].includes(v.trim().toLowerCase())
export const intOrNil = (v: string): number | null => { const t = v.trim().replace(/,/g, ''); if (t === '') return null; const n = Number(t); return Number.isInteger(n) ? n : null }
export const numOrNil = (v: string): number | null => { const t = v.trim().replace(/,/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null }
export const paiseOrNil = (v: string): number | null => { const n = numOrNil(v); return n === null ? null : Math.round(n * 100) }
export const firstOf = (row: Row, ...names: string[]): string => { for (const n of names) { const v = str(row[n]).trim(); if (v !== '') return v } return '' }
const blankWords = new Set(['no', 'none', 'nil', 'na', 'n/a', '-', '--', 'not applicable', 'not assigned', 'nan', 'null', 'tbd', 'to be decided', 'vacant', 'pending'])
export const optional = (row: Row, ...names: string[]): string => { const v = firstOf(row, ...names); return blankWords.has(v.trim().toLowerCase()) ? '' : v }
export const splitSubjects = (v: string): string[] => v.split(/[;,|]/).map((s) => s.trim()).filter((s) => s !== '')
export const isWholeNumber = (t: string): boolean => /^-?\d+$/.test(t)

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const ymd = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso + 'T00:00:00Z')) || new Date(iso + 'T00:00:00Z').getUTCDate() !== d ? null : iso
}
const fullYear = (y: number, raw: string): number => (raw.length <= 2 ? 2000 + y : y)

/** 2026-08-15, 15.08.26, 15/08/2026, 15-Aug-26, 15 Aug 2026: the shapes a holiday sheet holds (parseSheetDate). */
export function parseSheetDate(s: string): string {
  const v = s.trim()
  if (v === '') throw new Error('a date is required')
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) { const r = ymd(Number(m[1]), Number(m[2]), Number(m[3])); if (r) return r }
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/)
  if (m) { const r = ymd(fullYear(Number(m[3]), m[3]), Number(m[2]), Number(m[1])); if (r) return r }
  m = v.match(/^(\d{1,2})[- ]([A-Za-z]+)[- ](\d{2}|\d{4})$/)
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    const r = ymd(fullYear(Number(m[3]), m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1])); if (r) return r
  }
  throw new Error(`"${v}" is not a date I can read -- try 2026-08-15 or 15.08.26`)
}

/** The students sheet's date reader (normaliseDate): returns the input unchanged when it cannot read it. */
export function normaliseDate(s: string): string {
  const v = s.trim()
  if (v === '') return ''
  const tryYear = (r: string | null) => (r && Number(r.slice(0, 4)) > 1900 && Number(r.slice(0, 4)) < 2100 ? r : null)
  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) { const r = tryYear(ymd(Number(m[1]), Number(m[2]), Number(m[3]))); if (r) return r }
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  if (m) {
    const dmy = tryYear(ymd(Number(m[3]), Number(m[2]), Number(m[1]))); if (dmy) return dmy
    const mdy = tryYear(ymd(Number(m[3]), Number(m[1]), Number(m[2]))); if (mdy) return mdy
  }
  m = v.match(/^(\d{1,2})[- ]([A-Za-z]+)[- ](\d{2}|\d{4})$/)
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    const r = tryYear(ymd(fullYear(Number(m[3]), m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]))); if (r) return r
  }
  m = v.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/)
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    const r = tryYear(ymd(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]))); if (r) return r
  }
  return v
}

/** A punch time as the reader writes it, in school time, to a UTC instant (parsePunchTime). */
export function parsePunchTime(v: string): string {
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/)
  if (!m || Number.isNaN(Date.parse(m[1] + 'T00:00:00Z'))) throw new Error(`unrecognised punch time "${v}"`)
  return istToUTC(m[1], m[2] + ':' + (m[3] ?? '00'))
}

export function weekdayOf(s: string): number {
  const v = s.trim().toLowerCase()
  if (v === '') throw new Error('day is required')
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n < 1 || n > 7) throw new Error('day as a number must be 1 (Monday) to 7 (Sunday)')
    return n
  }
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  for (let i = 0; i < days.length; i++) if (v === days[i] || v === days[i].slice(0, 3)) return i + 1
  throw new Error(`"${s.trim().toLowerCase()}" is not a day of the week`)
}

const monthName = (iso: string): string => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** One dated row measured against the period the upload was given, both ends inclusive. */
export function withinWindow(f: SheetFacts, day: string, what: string): void {
  if (f.from !== '' && /^\d{4}-\d{2}-\d{2}$/.test(f.from) && day < f.from) {
    throw new Error(`${what} is ${monthName(day)}, before the ${monthName(f.from)} you chose. Check you have the right file for this period`)
  }
  if (f.to !== '' && /^\d{4}-\d{2}-\d{2}$/.test(f.to) && day > f.to) {
    throw new Error(`${what} is ${monthName(day)}, after the ${monthName(f.to)} you chose. Check you have the right file for this period`)
  }
}

export function subjectCodeFrom(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)
  return letters === '' ? 'SUBJ' : letters
}

export function classImportLevel(row: Row): number {
  const v = str(row.level).trim()
  if (v === '') {
    const level = classLevelFromName(str(row.name))
    if (level === 0) throw new Error('no year could be read from that name. Add a level column, or write it as Grade 6')
    return level
  }
  const n = Number(v)
  if (!isWholeNumber(v) || n === 0 || n < CLASS_LEVEL_FLOOR || n > CLASS_LEVEL_CEILING) {
    throw new Error(`level must be a whole number between ${CLASS_LEVEL_FLOOR} and ${CLASS_LEVEL_CEILING}, where the negatives are the pre-school years (-3 is Nursery, -2 LKG, -1 UKG). Leave it empty to take the year from the name`)
  }
  return n
}

/** A subject by code or name, created when the sheet names a new one, with a code made distinct rather than merged. */
export async function subjectIdFor(ctx: ImportCtx, want: string): Promise<{ id: string; fresh: boolean }> {
  const found = await ctx.db.prepare(`SELECT id FROM subjects WHERE institution_id = ? AND (upper(code) = upper(?) OR lower(name) = lower(?))`).bind(ctx.inst, want, want).first<{ id: string }>()
  if (found) return { id: found.id, fresh: false }
  const base = subjectCodeFrom(want)
  let code = base
  for (let n = 2; n < 100; n++) {
    const taken = await ctx.db.prepare(`SELECT 1 AS x FROM subjects WHERE institution_id = ? AND campus_id = ? AND upper(code) = upper(?) AND lower(name) <> lower(?)`)
      .bind(ctx.inst, ctx.campus, code, want).first()
    if (!taken) break
    code = `${base.replace(/[0-9]+$/, '')}${n}`
  }
  const byCode = await ctx.db.prepare(`SELECT id FROM subjects WHERE institution_id = ? AND campus_id = ? AND code = ?`).bind(ctx.inst, ctx.campus, code).first<{ id: string }>()
  if (byCode) return { id: byCode.id, fresh: false }
  const id = uuid()
  await ctx.db.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, ctx.inst, ctx.campus, want, code, now()).run()
  return { id, fresh: true }
}

async function classSubjectIdFor(ctx: ImportCtx, classId: string, subject: string): Promise<string> {
  const row = await ctx.db.prepare(`SELECT cs.id FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
      WHERE cs.class_id = ? AND (lower(sub.name) = lower(?) OR upper(sub.code) = upper(?)) LIMIT 1`).bind(classId, subject, subject).first<{ id: string }>()
  if (!row) throw new Error('no rows in result set')
  return row.id
}

async function studentIdFor(ctx: ImportCtx, adm: string): Promise<string> {
  const row = await ctx.db.prepare(`SELECT id FROM students WHERE institution_id = ? AND admission_no = ?`).bind(ctx.inst, adm).first<{ id: string }>()
  if (!row) throw new Error(`no child with admission number "${adm}". Import the students first`)
  return row.id
}

/** Every upsert here says whether it inserted; SQLite has no xmax, so this asks first. */
async function exists(ctx: ImportCtx, sql: string, ...args: unknown[]): Promise<string | null> {
  const row = await ctx.db.prepare(sql).bind(...args).first<{ id: string }>()
  return row?.id ?? null
}

/* --- the calendar ------------------------------------------------------------ */

interface CalendarEntry { name: string; kind: string }

export function sheetCalendarEntries(cell: string, kindColumn: string): CalendarEntry[] {
  const fallback = kindColumn.trim().toLowerCase()
  const out: CalendarEntry[] = []
  for (let part of cell.split('|')) {
    part = part.trim()
    if (part === '') continue
    const e: CalendarEntry = { name: part, kind: fallback }
    if (part.startsWith('[')) {
      const end = part.indexOf(']')
      if (end > 1) {
        const tag = part.slice(1, end).trim().toLowerCase()
        e.name = part.slice(end + 1).trim()
        if (['holiday', 'vacation', 'exam', 'event', 'ptm', 'working_day', 'term'].includes(tag)) e.kind = tag
        else if (['revision', 'activity', 'celebration', 'competition'].includes(tag)) e.kind = 'event'
        else if (tag === 'working day' || tag === 'working') e.kind = 'working_day'
      }
    }
    if (e.kind === '') e.kind = 'holiday'
    if (e.name === '') continue
    out.push(e)
  }
  return out
}

const holidayKinds = new Set(['holiday', 'vacation', 'exam', 'event', 'ptm', 'working_day'])

async function writeCalendarEntry(ctx: ImportCtx, e: CalendarEntry, from: string, to: string | null, applies: string, row: Row): Promise<void> {
  if (e.kind === 'term') {
    if (!ctx.year) throw new Error('create an academic year before loading terms')
    const endsOn = parseSheetDate(str(row.to))
    let seq = 0
    for (const f of e.name.split(/\s+/)) {
      const n = Number(f.replace(/^[.:-]+|[.:-]+$/g, ''))
      if (Number.isInteger(n) && n > 0 && n < 10) { seq = n; break }
    }
    if (seq === 0) {
      const r = await ctx.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM terms WHERE academic_year_id = ?`).bind(ctx.year).first<{ n: number }>()
      seq = r?.n ?? 1
    }
    const existing = await exists(ctx, `SELECT id FROM terms WHERE academic_year_id = ? AND lower(name) = lower(?)`, ctx.year, e.name)
    if (existing) {
      await ctx.db.prepare(`UPDATE terms SET starts_on = ?, ends_on = ?, sequence = ? WHERE id = ?`).bind(from, endsOn, seq, existing).run()
      return
    }
    const id = uuid()
    await ctx.db.prepare(`INSERT INTO terms (id, institution_id, academic_year_id, name, starts_on, ends_on, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, ctx.inst, ctx.year, e.name, from, endsOn, seq).run()
    ctx.noteCreated('terms', id, true)
    return
  }
  const existing = await exists(ctx, `SELECT id FROM holidays WHERE institution_id = ? AND campus_id IS NULL AND on_date = ? AND kind = ? AND lower(name) = lower(?)`, ctx.inst, from, e.kind, e.name)
  const note = nullStr(str(row.note))
  if (existing) {
    await ctx.db.prepare(`UPDATE holidays SET to_date = ?, applies_to = ?, description = COALESCE(?, description) WHERE id = ?`).bind(to, applies, note, existing).run()
    return
  }
  const id = uuid()
  await ctx.db.prepare(`INSERT INTO holidays (id, institution_id, academic_year_id, name, on_date, to_date, kind, applies_to, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ctx.inst, ctx.year, e.name, from, to, e.kind, applies, note).run()
  ctx.noteCreated('holidays', id, true)
}

/* --- staff sheet words ------------------------------------------------------- */

export function normaliseEmployment(v: string): string {
  switch (v.trim().toLowerCase()) {
    case 'permanent': case 'regular': case 'confirmed': return 'permanent'
    case 'contract': case 'contractual': return 'contract'
    case 'probation': case 'probationary': case 'on probation': return 'probation'
    case 'part time': case 'part-time': case 'parttime': return 'part_time'
    case 'visiting': case 'guest': case 'guest faculty': return 'visiting'
  }
  return ''
}
export function staffStatusValue(v: string): string {
  switch (v.trim().toLowerCase()) {
    case 'inactive': case 'left': case 'resigned': return 'resigned'
    case 'retired': return 'retired'
    case 'terminated': return 'terminated'
    case 'on leave': return 'on_leave'
    case 'suspended': return 'suspended'
  }
  return 'active'
}
export const isStaffStatusWord = (v: string): boolean =>
  ['active', 'inactive', 'left', 'resigned', 'retired', 'terminated', 'on leave', 'suspended'].includes(v.trim().toLowerCase())

export function staffRoleKey(role: string, designation: string): string {
  const known = new Set(['faculty', 'hod', 'class_teacher', 'vice_principal', 'institution_admin', 'hr', 'finance', 'admissions', 'librarian', 'nurse',
    'counsellor', 'front_office', 'transport_manager', 'driver', 'hostel_warden', 'exam_controller', 'it_admin', 'operations', 'discipline_officer',
    'activity_coord', 'board_member'])
  const k = role.trim().toLowerCase()
  if (known.has(k)) return k
  const byPost: Array<[string, string]> = [['vice principal', 'vice_principal'], ['head of department', 'hod'], ['headmistress', 'institution_admin'],
    ['headmaster', 'institution_admin'], ['principal', 'institution_admin'], ['class teacher', 'faculty'], ['librarian', 'librarian'], ['library', 'librarian'],
    ['accountant', 'finance'], ['accounts', 'finance'], ['cashier', 'finance'], ['admission', 'admissions'], ['counsel', 'counsellor'], ['nurse', 'nurse'],
    ['warden', 'hostel_warden'], ['driver', 'driver'], ['transport', 'transport_manager'], ['exam', 'exam_controller'], ['receptionist', 'front_office'],
    ['front office', 'front_office'], ['clerk', 'front_office'], ['office assistant', 'front_office'], ['hr', 'hr'], ['human resource', 'hr'],
    ['system admin', 'it_admin'], ['it admin', 'it_admin'], ['teacher', 'faculty'], ['lecturer', 'faculty'], ['tutor', 'faculty'], ['tgt', 'faculty'],
    ['pgt', 'faculty'], ['prt', 'faculty'], ['pet', 'faculty']]
  const post = designation.trim().toLowerCase()
  for (const [word, key] of byPost) if (post.includes(word)) return key
  return ''
}

const staffKnownColumns = new Set(['employee_code', 'first_name', 'last_name', 'email', 'phone', 'designation', 'role', 'joined_on', 'subjects'])
function leftoverColumns(row: Row, known: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) if (!known.has(k) && v.trim() !== '') out[k] = v.trim()
  return out
}

/* --- the specs ---------------------------------------------------------------- */

const attendanceStates = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday'])
const staffAttendanceStates = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday', 'week_off'])

export const importSpecs: Record<string, ImportSpec> = {
  classes: {
    perm: 'academics.write', columns: ['name', 'sections', 'capacity', 'strength'], required: ['name'], sample: ['Grade 6', 'A, B', '40', '38'],
    check: (row) => {
      const cap = str(row.capacity).replace(/,/g, '').trim()
      if (cap !== '' && (!isWholeNumber(cap) || Number(cap) <= 0)) throw new Error('capacity must be a whole number of seats above zero')
      const st = str(row.strength).replace(/,/g, '').trim()
      if (st !== '') {
        if (!isWholeNumber(st) || Number(st) < 0) throw new Error('strength must be a whole number of children, or blank')
        if (cap !== '' && isWholeNumber(cap) && Number(st) > Number(cap)) throw new Error('more children than seats: strength is above capacity')
      }
      classImportLevel(row)
    },
    write: async (ctx, row) => {
      const level = classImportLevel(row)
      const name = str(row.name).trim()
      let id = await exists(ctx, `SELECT id FROM classes WHERE institution_id = ? AND campus_id = ? AND name = ?`, ctx.inst, ctx.campus, name)
        ?? await exists(ctx, `SELECT id FROM classes WHERE institution_id = ? AND lower(name) = lower(?)`, ctx.inst, name)
      const existed = id !== null
      if (!id) {
        id = uuid()
        await ctx.db.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level, stream, created_at) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
          .bind(id, ctx.inst, ctx.campus, name, level, str(row.stream).trim(), now()).run()
      }
      ctx.noteCreated('classes', id, !existed)
      await ctx.writeSections(row, id)
    },
  },
  sections: {
    perm: 'academics.write', columns: ['class', 'name', 'capacity', 'room'], required: ['class', 'name'], sample: ['Grade 6', 'A', '40', ''],
    verify: async (ctx, row) => { await ctx.classID(str(row.class)) },
    check: (row) => {
      const v = str(row.capacity).trim()
      if (v !== '' && (!isWholeNumber(v) || Number(v) <= 0)) throw new Error('capacity must be a whole number above zero')
    },
    write: async (ctx, row) => {
      const classId = await ctx.classID(str(row.class))
      let capacity = 40
      const v = str(row.capacity).trim()
      if (v !== '') { if (isWholeNumber(v) && Number(v) > 0) capacity = Number(v); else throw new Error('capacity must be a whole number above zero') }
      if (!ctx.year) throw new Error('create an academic year before importing sections')
      const name = str(row.name).trim(), room = nullStr(str(row.room))
      const existing = await exists(ctx, `SELECT id FROM sections WHERE class_id = ? AND academic_year_id = ? AND name = ?`, classId, ctx.year, name)
      if (existing) { await ctx.db.prepare(`UPDATE sections SET capacity = ?, room = ? WHERE id = ?`).bind(capacity, room, existing).run(); return }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, capacity, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, ctx.inst, ctx.campus, classId, ctx.year, name, capacity, room, now()).run()
      ctx.noteCreated('sections', id, true)
    },
  },
  subjects: {
    perm: 'academics.write', columns: ['name', 'code', 'is_scholastic'], required: ['name', 'code'], sample: ['Mathematics', 'MATH', 'Y'],
    check: (row) => { if (str(row.code).trim() === '') throw new Error('code is what the report card prints; it cannot be blank') },
    write: async (ctx, row) => {
      const scholastic = isNo(str(row.is_scholastic)) ? 0 : 1
      const code = str(row.code).trim().toUpperCase(), name = str(row.name).trim()
      const existing = await exists(ctx, `SELECT id FROM subjects WHERE institution_id = ? AND campus_id = ? AND code = ?`, ctx.inst, ctx.campus, code)
      if (existing) { await ctx.db.prepare(`UPDATE subjects SET name = ?, is_scholastic = ? WHERE id = ?`).bind(name, scholastic, existing).run(); return }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code, is_scholastic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, ctx.inst, ctx.campus, name, code, scholastic, now()).run()
      ctx.noteCreated('subjects', id, true)
    },
  },
  periods: {
    perm: 'academics.write', columns: ['day', 'classes', 'sequence', 'name', 'starts_at', 'ends_at', 'is_break'], required: ['sequence', 'name'],
    sample: ['Primary', 'Nursery, LKG, UKG', '1', 'P1', '09:30', '10:10', 'N'],
    check: (row) => {
      const s = str(row.sequence).trim()
      if (!isWholeNumber(s) || Number(s) <= 0) throw new Error('sequence must be a whole number above zero. It is what orders the day')
      for (const k of ['starts_at', 'ends_at']) { const v = str(row[k]).trim(); if (v !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(k + ' must be a 24-hour time such as 09:45') }
    },
    verify: async (ctx, row) => { for (const name of str(row.classes).split(/[,;/]/)) if (name.trim() !== '') await ctx.classID(name.trim()) },
    write: async (ctx, row) => {
      const seq = Number(str(row.sequence).trim())
      const schedule = await ctx.bellScheduleID(str(row.day))
      const existing = await exists(ctx, `SELECT id FROM periods WHERE bell_schedule_id = ? AND sequence = ?`, schedule, seq)
      const startsAt = str(row.starts_at).trim(), endsAt = str(row.ends_at).trim()
      if (existing) {
        await ctx.db.prepare(`UPDATE periods SET name = ?, starts_at = ?, ends_at = ?, is_break = ? WHERE id = ?`).bind(str(row.name).trim(), startsAt, endsAt, isYes(str(row.is_break)) ? 1 : 0, existing).run()
      } else {
        const id = uuid()
        await ctx.db.prepare(`INSERT INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, ctx.inst, ctx.campus, schedule, str(row.name).trim(), seq, startsAt, endsAt, isYes(str(row.is_break)) ? 1 : 0).run()
        ctx.noteCreated('periods', id, true)
      }
      for (const name of str(row.classes).split(/[,;/]/)) {
        if (name.trim() === '') continue
        const classId = await ctx.classID(name.trim())
        await ctx.db.prepare(`UPDATE classes SET bell_schedule_id = ? WHERE id = ?`).bind(schedule, classId).run()
      }
    },
  },
  fee_heads: {
    perm: 'finance.fees.write', columns: ['name', 'code', 'is_recurring'], required: ['name', 'code'], sample: ['Tuition', 'TUI', 'Y'],
    write: async (ctx, row) => {
      const recurring = isNo(str(row.is_recurring)) ? 0 : 1
      const code = str(row.code).trim().toUpperCase(), name = str(row.name).trim()
      const existing = await exists(ctx, `SELECT id FROM fee_heads WHERE institution_id = ? AND code = ?`, ctx.inst, code)
      if (existing) { await ctx.db.prepare(`UPDATE fee_heads SET name = ?, is_recurring = ? WHERE id = ?`).bind(name, recurring, existing).run(); return }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO fee_heads (id, institution_id, name, code, is_recurring, is_taxable, gst_rate_bp, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`).bind(id, ctx.inst, name, code, recurring, now()).run()
      ctx.noteCreated('fee_heads', id, true)
    },
  },
  fee_structures: {
    perm: 'finance.fees.write', columns: ['structure', 'class', 'fee_head', 'annual_amount', 'instalments'], required: ['structure', 'fee_head', 'annual_amount'],
    sample: ['2026-2027', 'Grade 6', 'Tuition Fee', '45000', '3'],
    verify: async (ctx, row) => {
      if (str(row.class).trim() !== '') await ctx.classID(str(row.class).trim())
      const head = str(row.fee_head).trim()
      if (head === '') return
      const okRow = await ctx.db.prepare(`SELECT 1 AS x FROM fee_heads WHERE institution_id = ? AND (lower(name) = lower(?) OR upper(code) = upper(?))`).bind(ctx.inst, head, head).first()
      if (!okRow) throw new Error(`no fee head called "${head}". Add the fee heads first`)
    },
    check: (row) => {
      if (!Number.isFinite(Number(str(row.annual_amount).trim())) || str(row.annual_amount).trim() === '') throw new Error('annual_amount must be a number, in rupees')
      const v = str(row.instalments).trim()
      if (v !== '' && (!isWholeNumber(v) || Number(v) < 1 || Number(v) > 12)) throw new Error('instalments must be a whole number between 1 and 12')
    },
    write: async (ctx, row) => {
      const name = str(row.structure).trim()
      let classId: string | null = null
      if (str(row.class).trim() !== '') classId = await ctx.classID(str(row.class).trim())
      const want = str(row.fee_head).trim()
      const head = await ctx.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ? AND (upper(code) = upper(?) OR lower(name) = lower(?))`).bind(ctx.inst, want, want).first<{ id: string }>()
      if (!head) throw new Error(`no fee head called "${want}" -- add the fee heads first`)
      if (!ctx.year) throw new Error('create an academic year before loading fee structures')
      let structId = await exists(ctx, `SELECT id FROM fee_structures WHERE institution_id = ? AND name = ? AND class_id IS ?`, ctx.inst, name, classId)
      if (!structId) {
        structId = uuid()
        await ctx.db.prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name, applies_to, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 'all', 1, ?)`)
          .bind(structId, ctx.inst, ctx.campus, ctx.year, classId, name, now()).run()
        ctx.noteCreated('fee_structures', structId, true)
      }
      const total = Math.trunc(Number(str(row.annual_amount).trim()) * 100 + 0.5)
      let terms = str(row.instalments).trim() === '' ? 1 : Number(str(row.instalments).trim())
      if (terms < 1) terms = 1
      const each = Math.trunc(total / terms)
      const first = each + total - each * terms
      for (let n = 1; n <= terms; n++) {
        await ctx.db.prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (fee_structure_id, fee_head_id, instalment_no) DO UPDATE SET amount_paise = excluded.amount_paise`)
          .bind(uuid(), ctx.inst, structId, head.id, n, n === 1 ? first : each).run()
      }
    },
  },
  holidays: {
    perm: 'academics.write', columns: ['date', 'day', 'event', 'to', 'kind', 'applies_to', 'note'], required: ['date', 'event'],
    sample: ['2026-08-15', 'Saturday', '[Holiday] Independence Day', '', '', 'all', ''],
    skip: (row) => str(row.event).trim() === '',
    check: (row) => {
      try { parseSheetDate(str(row.date)) } catch (e) { throw new Error('date: ' + (e as Error).message) }
      if (str(row.to).trim() !== '') { try { parseSheetDate(str(row.to)) } catch (e) { throw new Error('to: ' + (e as Error).message) } }
      const k = str(row.kind).trim().toLowerCase()
      if (k !== '' && k !== 'term' && !holidayKinds.has(k)) throw new Error('kind must be holiday, vacation, exam, event, ptm, working_day or term')
      for (const e of sheetCalendarEntries(str(row.event), str(row.kind))) if (e.kind === 'term' && str(row.to).trim() === '') throw new Error("a term needs a 'to' date: when it ends")
      const a = str(row.applies_to).trim().toLowerCase()
      if (a !== '' && a !== 'all' && a !== 'students' && a !== 'staff') throw new Error('applies_to must be all, students or staff')
    },
    write: async (ctx, row) => {
      const from = parseSheetDate(str(row.date))
      const to = str(row.to).trim() !== '' ? parseSheetDate(str(row.to)) : null
      let applies = str(row.applies_to).trim().toLowerCase()
      if (applies === '') applies = 'all'
      for (const e of sheetCalendarEntries(str(row.event), str(row.kind))) await writeCalendarEntry(ctx, e, from, to, applies, row)
    },
  },
  timetable: {
    perm: 'academics.timetable.write', columns: ['class', 'section', 'day', 'period', 'subject', 'teacher', 'room'], required: ['class', 'day', 'period', 'subject'],
    sample: ['Grade 6', 'A', 'Monday', '1', 'Mathematics', 'Priya Rao', '6A'],
    check: (row) => { weekdayOf(str(row.day)); if (str(row.period).trim() === '') throw new Error('period is required: its number or its name') },
    verify: async (ctx, row) => {
      const classId = await ctx.classID(str(row.class).trim())
      await ctx.periodID(str(row.period).trim())
      const n = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.class_id = ? AND (lower(sub.name) = lower(?) OR upper(sub.code) = upper(?))`)
        .bind(classId, str(row.subject).trim(), str(row.subject).trim()).first<{ n: number }>()
      if (!n?.n) throw new Error(`${str(row.class).trim()} does not study "${str(row.subject).trim()}". Add it under what each class studies, or check the spelling`)
    },
    write: async (ctx, row) => {
      const yearId = ctx.workingYearID()
      const classId = await ctx.classID(str(row.class).trim())
      const sectionId = await ctx.sectionIDFor(str(row.class).trim(), str(row.section).trim())
      const periodId = await ctx.periodID(str(row.period).trim())
      const weekday = weekdayOf(str(row.day))
      const csId = await classSubjectIdFor(ctx, classId, str(row.subject).trim())
      let teacher: string | null = null
      if (str(row.teacher).trim() !== '') { try { teacher = await ctx.teacherByEmail(str(row.teacher).trim()) } catch { teacher = null } }
      const existing = await exists(ctx, `SELECT id FROM timetable_entries WHERE section_id = ? AND period_id = ? AND weekday = ?`, sectionId, periodId, weekday)
      if (existing) {
        await ctx.db.prepare(`UPDATE timetable_entries SET class_subject_id = ?, teacher_user_id = ?, room = NULLIF(?, '') WHERE id = ?`).bind(csId, teacher, str(row.room).trim(), existing).run()
        return
      }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
        .bind(id, ctx.inst, yearId, sectionId, periodId, weekday, csId, teacher, str(row.room).trim(), now()).run()
      ctx.noteCreated('timetable', id, true)
    },
  },
  class_subjects: {
    perm: 'academics.write', columns: ['subject', 'class', 'section', 'room', 'class_teacher', 'teacher', 'max_marks', 'periods_per_week'], required: ['subject'],
    sample: ['Mathematics', 'Grade 6', 'A', '6A', 'Priya Rao', 'T-014', '100', '6'],
    check: (row) => {
      const mm = str(row.max_marks).trim()
      if (mm !== '' && (!isWholeNumber(mm) || Number(mm) <= 0)) throw new Error('max_marks must be a whole number above zero')
      const pw = str(row.periods_per_week).trim()
      if (pw !== '' && (!isWholeNumber(pw) || Number(pw) < 0 || Number(pw) > 40)) throw new Error('periods_per_week must be a whole number, 0 to 40')
    },
    write: async (ctx, row) => {
      const subjectOnly = str(row.class).trim() === ''
      let classId = ''
      if (!subjectOnly) classId = await ctx.classID(str(row.class))
      let want = str(row.subject).trim()
      if (want === '') want = str(row.subject_code).trim()
      const subject = await subjectIdFor(ctx, want)
      ctx.noteCreated('subjects', subject.id, subject.fresh)
      if (subjectOnly) return
      const maxMarks = str(row.max_marks).trim() === '' ? 100 : Number(str(row.max_marks).trim())
      const pw = str(row.periods_per_week).trim()
      const perWeek = pw !== '' && isWholeNumber(pw) && Number(pw) > 0 ? Number(pw) : null
      let csId = await exists(ctx, `SELECT id FROM class_subjects WHERE class_id = ? AND subject_id = ?`, classId, subject.id)
      if (csId) {
        await ctx.db.prepare(`UPDATE class_subjects SET max_marks = ?, periods_per_week = COALESCE(?, periods_per_week) WHERE id = ?`).bind(maxMarks, perWeek, csId).run()
      } else {
        csId = uuid()
        await ctx.db.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id, max_marks, periods_per_week) VALUES (?, ?, ?, ?, ?, COALESCE(?, 0))`).bind(csId, ctx.inst, classId, subject.id, maxMarks, perWeek).run()
        ctx.noteCreated('class_subjects', csId, true)
      }
      let sectionId = ''
      const haveSection = str(row.section).trim() !== ''
      if (haveSection) {
        sectionId = await ctx.sectionIDFor(str(row.class), str(row.section))
        if (str(row.room).trim() !== '') await ctx.db.prepare(`UPDATE sections SET room = ? WHERE id = ?`).bind(str(row.room).trim(), sectionId).run()
        const ct = optional(row, 'class_teacher', 'class_teacher_email')
        if (ct !== '') await ctx.db.prepare(`UPDATE sections SET class_teacher_id = ? WHERE id = ?`).bind(await ctx.teacherByEmail(ct), sectionId).run()
      }
      const who = optional(row, 'teacher', 'teacher_email')
      if (who === '') return
      const teacher = await ctx.teacherByEmail(who)
      if (haveSection) {
        await ctx.db.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (section_id, class_subject_id) DO UPDATE SET teacher_user_id = excluded.teacher_user_id`).bind(uuid(), ctx.inst, sectionId, csId, teacher, now()).run()
        return
      }
      const secs = await ctx.db.prepare(`SELECT id FROM sections WHERE class_id = ?`).bind(classId).all<{ id: string }>()
      for (const s of secs.results) {
        await ctx.db.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (section_id, class_subject_id) DO UPDATE SET teacher_user_id = excluded.teacher_user_id`).bind(uuid(), ctx.inst, s.id, csId, teacher, now()).run()
      }
    },
  },
  allocations: {
    perm: 'academics.write', columns: ['class', 'section', 'room', 'class_teacher', 'subject', 'teacher'], required: ['class', 'section'],
    sample: ['Grade 6', 'A', '6A', 'Priya Rao', 'MATH', 'T-014'],
    verify: async (ctx, row) => {
      await ctx.sectionIDFor(str(row.class), str(row.section))
      for (const who of [optional(row, 'class_teacher', 'class_teacher_email'), optional(row, 'teacher', 'teacher_email')]) if (who !== '') await ctx.teacherByEmail(who)
    },
    write: async (ctx, row) => {
      const sectionId = await ctx.sectionIDFor(str(row.class), str(row.section))
      if (str(row.room).trim() !== '') await ctx.db.prepare(`UPDATE sections SET room = ? WHERE id = ?`).bind(str(row.room).trim(), sectionId).run()
      const ct = optional(row, 'class_teacher', 'class_teacher_email')
      if (ct !== '') await ctx.db.prepare(`UPDATE sections SET class_teacher_id = ? WHERE id = ?`).bind(await ctx.teacherByEmail(ct), sectionId).run()
      const code = firstOf(row, 'subject', 'subject_code')
      const who = optional(row, 'teacher', 'teacher_email')
      if (code === '' || who === '') return
      const teacher = await ctx.teacherByEmail(who)
      const cs = await ctx.db.prepare(`SELECT cs.id, cs.subject_id FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id JOIN sections sec ON sec.class_id = cs.class_id
          WHERE sec.id = ? AND cs.institution_id = ? AND (upper(sub.code) = upper(?) OR lower(sub.name) = lower(?))`).bind(sectionId, ctx.inst, code, code).first<{ id: string; subject_id: string }>()
      if (!cs) throw new Error(`${str(row.class)} does not study "${code}". Map the subject to the class first`)
      let allocId = await exists(ctx, `SELECT id FROM section_subject_teachers WHERE section_id = ? AND class_subject_id = ?`, sectionId, cs.id)
      if (allocId) await ctx.db.prepare(`UPDATE section_subject_teachers SET teacher_user_id = ? WHERE id = ?`).bind(teacher, allocId).run()
      else {
        allocId = uuid()
        await ctx.db.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(allocId, ctx.inst, sectionId, cs.id, teacher, now()).run()
        ctx.noteCreated('allocations', allocId, true)
      }
      await ctx.db.prepare(`INSERT OR IGNORE INTO teacher_subjects (institution_id, user_id, subject_id, created_at) VALUES (?, ?, ?, ?)`).bind(ctx.inst, teacher, cs.subject_id, now()).run()
    },
  },
  staff: {
    perm: 'hr.employees.write', identity: 'employee_code',
    columns: ['employee_code', 'first_name', 'last_name', 'email', 'phone', 'designation', 'department', 'employment_type', 'status', 'role', 'joined_on', 'relieved_on', 'subjects'],
    required: ['employee_code', 'first_name'],
    sample: ['YPS001', 'Priya Rao', '', 'priya@school.in', '9876543210', 'Teacher', 'Teaching staff', 'Permanent', 'Active', 'faculty', '01 Jan 2024', '', 'MATH; SCI'],
    check: (row) => {
      const v = str(row.joined_on).trim()
      if (v !== '' && normaliseDate(v) === v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('joined_on is not a date this can read. Write it as 2026-06-01, 01/06/2026 or 01 Jun 2026')
    },
    verify: async (ctx, row) => {
      for (const want of splitSubjects(str(row.subjects))) {
        const okRow = await ctx.db.prepare(`SELECT 1 AS x FROM subjects WHERE institution_id = ? AND (upper(code) = upper(?) OR lower(name) = lower(?))`).bind(ctx.inst, want, want).first()
        if (!okRow) throw new Error(`no subject called "${want}". Check the Subjects step for the exact name`)
      }
    },
    write: async (ctx, row) => {
      if (isStaffStatusWord(str(row.designation)) && !isStaffStatusWord(str(row.status))) { const d = row.designation; row.designation = row.status; row.status = d }
      const designationId = await ctx.designationID(str(row.designation))
      const departmentId = await ctx.departmentID(str(row.department))
      let first = str(row.first_name).trim(), last = str(row.last_name).trim()
      if (last === '') { const i = first.lastIndexOf(' '); if (i > 0) { last = first.slice(i + 1).trim(); first = first.slice(0, i).trim() } }
      const email = str(row.email).trim(), phone = str(row.phone).trim()
      const roleKey = staffRoleKey(str(row.role), str(row.designation))
      const code = str(row.employee_code).trim()
      let out: { empId: string; userId: string; created: boolean }
      try {
        out = await appointEmployee(ctx.c, ctx.campus, {
          employee_code: code, first_name: first, last_name: last, email, phone, designation_id: designationId, department_id: departmentId,
          employment_type: normaliseEmployment(str(row.employment_type)), joined_on: normaliseDate(str(row.joined_on)), role_key: roleKey,
          create_login: (email !== '' || phone !== '') && roleKey !== '',
        })
      } catch (e) {
        if (e instanceof PhoneInUse) throw new Error(e.message)
        throw e
      }
      const left = normaliseDate(str(row.relieved_on))
      if (left !== '') {
        await ctx.db.prepare(`UPDATE employees SET relieved_on = ?, status = CASE WHEN status = 'active' THEN 'resigned' ELSE status END WHERE institution_id = ? AND employee_code = ?`).bind(left, ctx.inst, code).run()
      } else {
        const st = str(row.status).trim().toLowerCase()
        if (st !== '' && isStaffStatusWord(st) && st !== 'active') {
          await ctx.db.prepare(`UPDATE employees SET status = ? WHERE institution_id = ? AND employee_code = ?`).bind(staffStatusValue(st), ctx.inst, code).run()
        }
      }
      ctx.noteCreated('staff', out.empId, out.created)
      const extra = leftoverColumns(row, staffKnownColumns)
      if (Object.keys(extra).length > 0) {
        const cur = await ctx.db.prepare(`SELECT custom_fields FROM employees WHERE id = ?`).bind(out.empId).first<{ custom_fields: string }>()
        let fields: Record<string, unknown> = {}
        try { fields = JSON.parse(cur?.custom_fields || '{}') } catch { fields = {} }
        await ctx.db.prepare(`UPDATE employees SET custom_fields = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify({ ...fields, ...extra }), now(), out.empId).run()
      }
      const list = str(row.subjects).trim()
      if (list === '') return
      if (out.userId.trim() === '') {
        throw new Error(`"${str(row.first_name).trim()}" teaches ${list}, and what somebody teaches is held against their login. This row has no email or phone, or no role to give, ` +
          'so no account was made and the subjects would be lost. Add an email or a phone number and a role, or leave the subjects column out and set them on the allocation sheet')
      }
      for (const want of splitSubjects(list)) {
        const sub = await ctx.db.prepare(`SELECT id FROM subjects WHERE upper(code) = upper(?) OR lower(name) = lower(?) LIMIT 1`).bind(want, want).first<{ id: string }>()
        if (!sub) throw new Error(`no subject called "${want}". Add the subjects first`)
        await ctx.db.prepare(`INSERT OR IGNORE INTO teacher_subjects (institution_id, user_id, subject_id, created_at) VALUES (?, ?, ?, ?)`).bind(ctx.inst, out.userId, sub.id, now()).run()
      }
    },
  },
  student_history: {
    perm: 'students.write', columns: ['admission_no', 'year', 'class', 'days_present', 'days_total', 'fee_billed', 'fee_paid', 'fee_waived', 'notes'],
    required: ['admission_no', 'year'], sample: ['ADM0001', '2025-26', 'Grade 5', '187', '210', '35500', '35500', '0', 'Promoted with distinction'],
    check: (row) => {
      for (const k of ['days_present', 'days_total', 'fee_billed', 'fee_paid', 'fee_waived']) {
        const v = str(row[k]).trim()
        if (v === '') continue
        const n = Number(v.replace(/,/g, ''))
        if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number that is not negative`)
      }
      const pres = str(row.days_present).trim(), total = str(row.days_total).trim()
      if (pres !== '' && total !== '') { const a = Number(pres.replace(/,/g, '')), b = Number(total.replace(/,/g, '')); if (b > 0 && a > b) throw new Error('days_present is more than days_total') }
    },
    verify: async (ctx, row) => { await studentIdFor(ctx, str(row.admission_no).trim()) },
    write: async (ctx, row) => {
      const studentId = await studentIdFor(ctx, str(row.admission_no).trim())
      const year = str(row.year).trim()
      const existing = await exists(ctx, `SELECT id FROM student_year_history WHERE student_id = ? AND year_name = ?`, studentId, year)
      const vals = [nullStr(str(row.class)), intOrNil(str(row.days_present)), intOrNil(str(row.days_total)), paiseOrNil(str(row.fee_billed)), paiseOrNil(str(row.fee_paid)), paiseOrNil(str(row.fee_waived)), nullStr(str(row.notes))]
      if (existing) {
        await ctx.db.prepare(`UPDATE student_year_history SET class_name = ?, days_present = ?, days_total = ?, fee_billed_paise = ?, fee_paid_paise = ?, fee_waived_paise = ?, notes = ?, updated_at = ? WHERE id = ?`)
          .bind(...vals, now(), existing).run()
        return
      }
      const id = uuid()
      const t = now()
      await ctx.db.prepare(`INSERT INTO student_year_history (id, institution_id, student_id, year_name, class_name, days_present, days_total, fee_billed_paise, fee_paid_paise, fee_waived_paise, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ctx.inst, studentId, year, ...vals, t, t).run()
      ctx.noteCreated('student_history', id, true)
    },
  },
  staff_history: {
    perm: 'hr.employees.write', columns: ['employee_code', 'year', 'designation', 'days_present', 'days_total', 'leaves_taken', 'notes'], required: ['employee_code', 'year'],
    sample: ['T-014', '2025-26', 'Senior Teacher', '212', '220', '8', 'Class teacher, Grade 5-A'],
    check: (row) => {
      for (const k of ['days_present', 'days_total', 'leaves_taken']) {
        const v = str(row[k]).replace(/,/g, '').trim()
        if (v === '') continue
        if (!isWholeNumber(v) || Number(v) < 0) throw new Error(`${k} must be a whole number that is not negative`)
      }
      const pres = str(row.days_present).replace(/,/g, '').trim(), total = str(row.days_total).replace(/,/g, '').trim()
      if (pres !== '' && total !== '' && Number(total) > 0 && Number(pres) > Number(total)) throw new Error('days_present is more than days_total')
    },
    verify: async (ctx, row) => {
      const okRow = await ctx.db.prepare(`SELECT 1 AS x FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(ctx.inst, str(row.employee_code).trim()).first()
      if (!okRow) throw new Error(`nobody on the roll with employee code "${str(row.employee_code).trim()}". Import the staff first`)
    },
    write: async (ctx, row) => {
      const emp = await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(ctx.inst, str(row.employee_code).trim()).first<{ id: string }>()
      if (!emp) throw new Error('no rows in result set')
      const year = str(row.year).trim()
      const vals = [nullStr(str(row.designation)), intOrNil(str(row.days_present)), intOrNil(str(row.days_total)), intOrNil(str(row.leaves_taken)), nullStr(str(row.notes))]
      const existing = await exists(ctx, `SELECT id FROM employee_year_history WHERE employee_id = ? AND year_name = ?`, emp.id, year)
      if (existing) {
        await ctx.db.prepare(`UPDATE employee_year_history SET designation = ?, days_present = ?, days_total = ?, leaves_taken = ?, notes = ?, updated_at = ? WHERE id = ?`).bind(...vals, now(), existing).run()
        return
      }
      const id = uuid()
      const t = now()
      await ctx.db.prepare(`INSERT INTO employee_year_history (id, institution_id, employee_id, year_name, designation, days_present, days_total, leaves_taken, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, ctx.inst, emp.id, year, ...vals, t, t).run()
      ctx.noteCreated('staff_history', id, true)
    },
  },
  attendance: {
    perm: 'academics.attendance.write', columns: ['admission_no', 'date', 'status', 'remarks'], required: ['admission_no', 'date', 'status'],
    sample: ['ADM0001', '2026-07-14', 'present', ''],
    check: (row) => {
      if (str(row.admission_no).trim() === '') throw new Error("every row needs the child's admission number")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(row.date).trim()) || Number.isNaN(Date.parse(str(row.date).trim() + 'T00:00:00Z'))) throw new Error('date must be a day like 2026-07-14')
      const st = str(row.status).trim().toLowerCase()
      if (!attendanceStates.has(st)) throw new Error(`"${st}" is not an attendance state. Use one of: present, absent, late, half_day, leave, holiday`)
    },
    verify: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const st = await ctx.db.prepare(`SELECT (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS section_id FROM students st WHERE st.institution_id = ? AND st.admission_no = ?`)
        .bind(ctx.inst, adm).first<{ section_id: string | null }>()
      if (!st) throw new Error(`no child with admission number "${adm}". Import the students first`)
      withinWindow(ctx.sheet, str(row.date).trim(), 'this day')
      if (!st.section_id) throw new Error(`${adm} is not in any class yet, so there is no register to mark them on`)
    },
    write: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const st = await ctx.db.prepare(`SELECT st.id, (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS section_id FROM students st WHERE st.institution_id = ? AND st.admission_no = ?`)
        .bind(ctx.inst, adm).first<{ id: string; section_id: string }>()
      if (!st) throw new Error('no rows in result set')
      const onDate = str(row.date).trim(), status = str(row.status).trim().toLowerCase(), remarks = nullStr(str(row.remarks))
      const existing = await exists(ctx, `SELECT id FROM student_attendance WHERE student_id = ? AND on_date = ? AND period_id IS NULL`, st.id, onDate)
      if (existing) {
        await ctx.db.prepare(`UPDATE student_attendance SET status = ?, remarks = ?, marked_by = ?, marked_at = ? WHERE id = ?`).bind(status, remarks, ctx.c.id.userId, now(), existing).run()
        return
      }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, status, remarks, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, ctx.inst, st.id, st.section_id, onDate, status, remarks, ctx.c.id.userId, now()).run()
      ctx.noteCreated('attendance', id, true)
    },
  },
  staff_attendance: {
    perm: 'hr.attendance.write', columns: ['employee_code', 'date', 'status', 'check_in', 'check_out', 'remarks'], required: ['employee_code', 'date', 'status'],
    sample: ['EMP001', '2026-07-14', 'present', '09:05', '16:30', ''],
    check: (row) => {
      if (str(row.employee_code).trim() === '') throw new Error("every row needs the staff member's code")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(row.date).trim()) || Number.isNaN(Date.parse(str(row.date).trim() + 'T00:00:00Z'))) throw new Error('date must be a day like 2026-07-14')
      const st = str(row.status).trim().toLowerCase()
      if (!staffAttendanceStates.has(st)) throw new Error(`"${st}" is not an attendance state. Use one of: present, absent, late, half_day, leave, holiday, week_off`)
      for (const k of ['check_in', 'check_out']) { const v = str(row[k]).trim(); if (v !== '' && !isClock(v)) throw new Error(`${k} must be a 24-hour time like 09:05`) }
    },
    verify: async (ctx, row) => {
      const code = str(row.employee_code).trim()
      const e = await ctx.db.prepare(`SELECT user_id FROM employees WHERE institution_id = ? AND lower(employee_code) = lower(?)`).bind(ctx.inst, code).first<{ user_id: string | null }>()
      if (!e) throw new Error(`no staff member with code "${code}". Import the staff first`)
      withinWindow(ctx.sheet, str(row.date).trim(), 'this day')
      if (!e.user_id) throw new Error(`${code} has no login yet, and the staff register is kept against the login. Give them one under Staff → Logins, then upload this again`)
    },
    write: async (ctx, row) => {
      const code = str(row.employee_code).trim()
      const e = await ctx.db.prepare(`SELECT user_id, campus_id FROM employees WHERE institution_id = ? AND lower(employee_code) = lower(?)`).bind(ctx.inst, code).first<{ user_id: string; campus_id: string | null }>()
      if (!e) throw new Error('no rows in result set')
      const onDate = str(row.date).trim()
      const checkIn = str(row.check_in).trim() === '' ? null : istToUTC(onDate, str(row.check_in).trim())
      const checkOut = str(row.check_out).trim() === '' ? null : istToUTC(onDate, str(row.check_out).trim())
      const status = str(row.status).trim().toLowerCase(), remarks = nullStr(str(row.remarks))
      const existing = await exists(ctx, `SELECT id FROM staff_attendance WHERE user_id = ? AND on_date = ?`, e.user_id, onDate)
      if (existing) {
        await ctx.db.prepare(`UPDATE staff_attendance SET status = ?, check_in = ?, check_out = ?, remarks = ?, marked_by = ? WHERE id = ?`).bind(status, checkIn, checkOut, remarks, ctx.c.id.userId, existing).run()
        return
      }
      const id = uuid()
      await ctx.db.prepare(`INSERT INTO staff_attendance (id, institution_id, campus_id, user_id, on_date, status, check_in, check_out, source, remarks, marked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`)
        .bind(id, ctx.inst, e.campus_id, e.user_id, onDate, status, checkIn, checkOut, remarks, ctx.c.id.userId, now()).run()
      ctx.noteCreated('staff_attendance', id, true)
    },
  },
  marks: {
    perm: 'academics.marks.write', columns: ['admission_no', 'year', 'exam', 'class', 'subject', 'max_marks', 'marks_obtained', 'grade'],
    required: ['admission_no', 'year', 'exam', 'class', 'subject', 'max_marks'], sample: ['ADM0001', '2025-26', 'Annual Examination', 'Grade 5', 'Mathematics', '100', '87', 'A1'],
    check: (row) => {
      const maxM = Number(str(row.max_marks).trim())
      if (str(row.max_marks).trim() === '' || !Number.isFinite(maxM) || maxM <= 0) throw new Error('max_marks must be a number above zero')
      const got = str(row.marks_obtained).trim()
      if (got === '') return
      const n = Number(got)
      if (!Number.isFinite(n) || n < 0) throw new Error('marks_obtained must be a number that is not negative, or blank for absent')
      if (n > maxM) throw new Error(`marks_obtained (${got}) is more than max_marks (${str(row.max_marks)})`)
    },
    verify: async (ctx, row) => {
      await studentIdFor(ctx, str(row.admission_no).trim())
      const classId = await ctx.classID(str(row.class))
      const subject = str(row.subject).trim()
      const okRow = await ctx.db.prepare(`SELECT 1 AS x FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.class_id = ? AND (lower(sub.name) = lower(?) OR upper(sub.code) = upper(?))`).bind(classId, subject, subject).first()
      if (!okRow) throw new Error(`${str(row.class).trim()} does not teach "${subject}". Check the class-subject list for the exact name`)
    },
    write: async (ctx, row) => {
      const studentId = await studentIdFor(ctx, str(row.admission_no).trim())
      const classId = await ctx.classID(str(row.class))
      const yearId = await ctx.pastYearID(str(row.year).trim())
      const examId = await ctx.pastExamID(yearId, str(row.exam).trim())
      const csId = await classSubjectIdFor(ctx, classId, str(row.subject).trim())
      const examSubjectId = await examSubjectFor(ctx, examId, csId, Number(str(row.max_marks).trim()))
      const got = str(row.marks_obtained).trim()
      await writeMark(ctx, examSubjectId, studentId, got === '' ? null : String(Number(got)), nullStr(str(row.grade)), got === '')
    },
  },
  marks_grid: {
    perm: 'academics.marks.write', columns: ['admission_no'], required: ['admission_no'], sample: ['ADM0001'],
    check: (row) => { if (str(row.admission_no).trim() === '') throw new Error("every row needs the child's admission number") },
    verify: async (ctx, row) => {
      await studentIdFor(ctx, str(row.admission_no).trim())
      if (Object.keys(ctx.subjectCols).length === 0) throw new Error('no subject columns were chosen. Point at least one column at a subject, so the marks in it have somewhere to go')
      const classId = await ctx.classID(ctx.sheet.class)
      for (const [subject, header] of Object.entries(ctx.subjectCols)) {
        const okRow = await ctx.db.prepare(`SELECT 1 AS x FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.class_id = ? AND (lower(sub.name) = lower(?) OR upper(sub.code) = upper(?))`).bind(classId, subject, subject).first()
        if (!okRow) throw new Error(`${ctx.sheet.class} does not teach "${subject}", which you pointed the "${header}" column at`)
      }
      for (const subject of Object.keys(ctx.subjectCols)) {
        const v = str(row[normaliseHeader('subject:' + subject)]).trim()
        if (v === '' || v.toUpperCase() === 'AB' || v.toUpperCase() === 'A') continue
        const n = Number(v.replace(/,/g, ''))
        if (!Number.isFinite(n) || n < 0) throw new Error(`${subject} is "${v}", which is not a mark. Leave it blank, or write AB for absent`)
        if (ctx.sheet.maxMarks > 0 && n > ctx.sheet.maxMarks) throw new Error(`${subject} is ${v}, more than the ${ctx.sheet.maxMarks} the paper is out of`)
      }
    },
    write: async (ctx, row) => {
      const studentId = await studentIdFor(ctx, str(row.admission_no).trim())
      const classId = await ctx.classID(ctx.sheet.class)
      const yearId = await ctx.pastYearID(ctx.sheet.year)
      const examId = await ctx.pastExamID(yearId, ctx.sheet.exam)
      for (const subject of Object.keys(ctx.subjectCols)) {
        const raw = str(row[normaliseHeader('subject:' + subject)]).trim()
        if (raw === '') continue
        const csId = await classSubjectIdFor(ctx, classId, subject)
        const examSubjectId = await examSubjectFor(ctx, examId, csId, ctx.sheet.maxMarks)
        const absent = raw.toUpperCase() === 'AB' || raw.toUpperCase() === 'A'
        await writeMark(ctx, examSubjectId, studentId, absent ? null : String(Number(raw.replace(/,/g, ''))), null, absent, true)
      }
    },
  },
  punches: {
    perm: 'hr.attendance.write', columns: ['device_serial', 'device_user_id', 'name', 'punched_at'], required: ['device_serial', 'device_user_id', 'punched_at'],
    sample: ['OGJ3220160104', 'T001', 'RAMYASRI.R', '2026-09-02 08:40:55'],
    check: (row) => {
      const uid = str(row.device_user_id).trim().toUpperCase()
      if (uid === '') throw new Error('device_user_id is required: it is the id enrolled on the reader, such as T001')
      if (uid.length > 64) throw new Error('device_user_id is longer than any reader issues; check the columns are lined up')
      let at: string
      try { at = parsePunchTime(str(row.punched_at)) } catch { throw new Error('punched_at must be a date and time as the reader writes it, such as 2026-09-02 08:40:55') }
      if (Date.parse(at) > Date.now() + 24 * 3600_000) throw new Error(`punched_at is in the future (${str(row.punched_at).trim()}); check the date column`)
    },
    verify: async (ctx, row) => {
      const devId = await ctx.deviceBySerial(str(row.device_serial))
      const uid = str(row.device_user_id).trim().toUpperCase()
      const at = parsePunchTime(str(row.punched_at))
      const key = devId + '\0' + uid + '\0' + at
      if (ctx.punchSeen.has(key)) throw new Error(`this file already has a punch for ${uid} at ${str(row.punched_at).trim()} on this reader; the repeat is skipped so the day is not counted twice`)
      ctx.punchSeen.add(key)
      const seen = await ctx.db.prepare(`SELECT 1 AS x FROM biometric_punches WHERE institution_id = ? AND device_id = ? AND device_user_id = ? AND punched_at = ?`).bind(ctx.inst, devId, uid, at).first()
      if (seen) throw new Error(`${uid} already has a punch at ${str(row.punched_at).trim()} on this reader, so this row was loaded before; it is skipped rather than counted twice`)
    },
    write: async (ctx, row) => {
      const devId = await ctx.deviceBySerial(str(row.device_serial))
      const uid = str(row.device_user_id).trim().toUpperCase()
      const at = parsePunchTime(str(row.punched_at))
      const raw = [str(row.device_serial).trim(), uid, str(row.name).trim(), str(row.punched_at).trim()].join('\t')
      const dup = await ctx.db.prepare(`SELECT 1 AS x FROM biometric_punches WHERE device_id = ? AND device_user_id = ? AND punched_at = ?`).bind(devId, uid, at).first()
      if (dup) return
      const emp = await ctx.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND upper(CAST(device_user_id AS TEXT)) = ?`).bind(ctx.inst, uid).first<{ id: string }>()
      await ctx.db.prepare(`INSERT INTO biometric_punches (id, institution_id, device_id, device_user_id, employee_id, punched_at, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), ctx.inst, devId, uid, emp?.id ?? null, at, raw, now()).run()
      if (!emp) return
      await rollUpImportedDay(ctx, emp.id, at, str(row.device_serial).trim())
    },
  },
  student_exits: {
    perm: 'students.write', columns: ['admission_no', 'exit_date', 'status', 'reason', 'tc_no', 'tc_issued_on'], required: ['admission_no'],
    sample: ['ADM0001', '2026-03-31', 'transferred', 'TC issued', '42817', '2026-03-31'],
    check: (row) => {
      if (str(row.admission_no).trim() === '') throw new Error("every row needs the child's admission number")
      const d = str(row.exit_date).trim()
      if (d !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw new Error('exit_date must be a day like 2026-03-31')
        if (Date.parse(d + 'T00:00:00Z') > Date.now() + 24 * 3600_000) throw new Error('a leaving date cannot be in the future')
      }
      const t = str(row.tc_issued_on).trim()
      if (t !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t + 'T00:00:00Z')))) throw new Error('tc_issued_on must be a day like 2026-03-31')
      const st = str(row.status).trim().toLowerCase()
      if (st !== '' && !['transferred', 'graduated', 'withdrawn', 'alumni'].includes(st)) throw new Error(`"${st}" is not a way of leaving. Use one of: transferred, graduated, withdrawn, alumni`)
    },
    verify: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const s = await ctx.db.prepare(`SELECT status FROM students WHERE institution_id = ? AND admission_no = ?`).bind(ctx.inst, adm).first<{ status: string }>()
      if (!s) throw new Error(`no child with admission number "${adm}" on the roll`)
      if (s.status !== 'active' && s.status !== 'suspended') throw new Error(`${adm} has already left (${s.status}). Remove the row if this is last term's list`)
      const tc = str(row.tc_no).trim()
      if (tc !== '') {
        const seen = await ctx.db.prepare(`SELECT 1 AS x FROM issued_certificates WHERE institution_id = ? AND serial_no = ?`).bind(ctx.inst, tc).first()
        if (seen) throw new Error(`certificate number ${tc} has already been issued to somebody. Check the number, or leave it blank to have one generated`)
      }
      /* The numbering series (fees.NextNumber) belongs to the finance port,
         so a transfer without a certificate number is refused here rather
         than numbered wrongly. */
      const st = str(row.status).trim().toLowerCase() || 'transferred'
      if (st === 'transferred' && tc === '') throw new Error('give the transfer certificate its number in tc_no; the Worker cannot draw one from the school\'s series yet')
    },
    write: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const s = await ctx.db.prepare(`SELECT id FROM students WHERE institution_id = ? AND admission_no = ?`).bind(ctx.inst, adm).first<{ id: string }>()
      if (!s) throw new Error('no rows in result set')
      let status = str(row.status).trim().toLowerCase()
      if (status === '') status = 'transferred'
      const exitDate = nullStr(str(row.exit_date)) ?? todayIndia()
      await ctx.db.prepare(`UPDATE students SET status = ?, exit_date = ?, exit_reason = NULLIF(?, ''), updated_at = ? WHERE id = ?`).bind(status, exitDate, str(row.reason).trim(), now(), s.id).run()
      await ctx.db.prepare(`UPDATE enrollments SET status = ? WHERE student_id = ? AND status = 'active'`).bind(status, s.id).run()
      if (status === 'transferred') {
        const serial = str(row.tc_no).trim()
        if (serial === '') throw new Error('give the transfer certificate its number in tc_no')
        let issuedOn = str(row.tc_issued_on).trim()
        if (issuedOn === '') issuedOn = str(row.exit_date).trim()
        let type = await ctx.db.prepare(`SELECT id FROM certificate_types WHERE code = 'TC'`).first<{ id: string }>()
        if (!type) {
          const id = uuid()
          await ctx.db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, requires_approval, updated_at) VALUES (?, ?, 'TC', 'Transfer Certificate', 0, ?)`).bind(id, ctx.inst, now()).run()
          type = { id }
        }
        const snap = await ctx.db.prepare(`SELECT TRIM(st.first_name || ' ' || COALESCE(st.middle_name || ' ', '') || COALESCE(st.last_name, '')) AS name, st.admission_no, st.date_of_birth,
            c.name AS class, sec.name AS section, st.admission_date, st.apaar_id FROM students st
            LEFT JOIN (SELECT e.student_id, e.class_id, e.section_id FROM enrollments e WHERE e.student_id = ? ORDER BY e.enrolled_on DESC LIMIT 1) en ON en.student_id = st.id
            LEFT JOIN classes c ON c.id = en.class_id LEFT JOIN sections sec ON sec.id = en.section_id WHERE st.id = ?`).bind(s.id, s.id).first<Record<string, unknown>>()
        const snapshot = { ...(snap ?? {}), reason: nullStr(str(row.reason)), carried_across: true, issued_at: now() }
        await ctx.db.prepare(`INSERT INTO issued_certificates (id, institution_id, certificate_type_id, student_id, serial_no, issued_on, snapshot, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`)
          .bind(uuid(), ctx.inst, type.id, s.id, serial, nullStr(issuedOn) ?? todayIndia(), JSON.stringify(snapshot), ctx.c.id.userId, now()).run()
      }
      await endFamilyAccess(ctx.c, s.id)
      ctx.noteCreated('student_exits', s.id, false)
    },
  },
  fee_payments: {
    perm: 'finance.fees.write', columns: ['admission_no', 'receipt_no', 'paid_on', 'amount', 'mode', 'remarks'], required: ['admission_no', 'paid_on', 'amount'],
    sample: ['ADM0001', 'R-2026-0417', '2026-04-11', '18500', 'cash', 'Term 1'],
    check: (row) => {
      if (str(row.admission_no).trim() === '') throw new Error("every row needs the child's admission number")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(row.paid_on).trim()) || Number.isNaN(Date.parse(str(row.paid_on).trim() + 'T00:00:00Z'))) throw new Error('paid_on must be a date like 2026-04-11')
      const amt = paiseOrNil(str(row.amount))
      if (amt === null) throw new Error('amount must be a number of rupees, like 18500')
      if (amt <= 0) throw new Error('amount must be more than nothing')
      const mode = str(row.mode).trim().toLowerCase()
      if (mode !== '' && !['cash', 'cheque', 'dd', 'neft', 'upi', 'card', 'netbanking', 'adjustment', 'wallet'].includes(mode)) {
        throw new Error(`"${mode}" is not a way of paying. Use one of: cash, cheque, dd, neft, upi, card, netbanking, adjustment`)
      }
    },
    verify: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const studentId = await studentIdFor(ctx, adm)
      withinWindow(ctx.sheet, str(row.paid_on).trim(), 'this receipt')
      const rec = str(row.receipt_no).trim()
      if (rec !== '') {
        const seen = await ctx.db.prepare(`SELECT 1 AS x FROM payments WHERE institution_id = ? AND student_id = ? AND reference_no = ?`).bind(ctx.inst, studentId, rec).first()
        if (seen) throw new Error(`receipt ${rec} is already recorded against this child. Remove the row, or clear its receipt number if it really is a second payment`)
      }
    },
    write: async (ctx, row) => {
      const adm = str(row.admission_no).trim()
      const s = await ctx.db.prepare(`SELECT id FROM students WHERE institution_id = ? AND admission_no = ?`).bind(ctx.inst, adm).first<{ id: string }>()
      if (!s) throw new Error('no rows in result set')
      const amount = paiseOrNil(str(row.amount)) ?? 0
      // What a school means when it does not say. Every counter takes cash; nothing else is safe to assume.
      const mode = str(row.mode).trim().toLowerCase() || 'cash'
      // fees.Collect, the counter's own path: receipt series, allocation, invoice/payment sync.
      const r = await collect(ctx.c, { studentId: s.id, amount, mode, paidOn: str(row.paid_on).trim(),
        referenceNo: str(row.receipt_no).trim(), remarks: str(row.remarks).trim() })
      try { await ctx.db.batch(r.stmts) } catch (e) {
        if (isBatchGuardFailure(e)) throw new Error('another receipt was issued at the same moment; try again')
        throw e
      }
      ctx.noteCreated('fee_payments', r.paymentId, true)
    },
  },
}
registerImportSpecsExtra(importSpecs)

async function examSubjectFor(ctx: ImportCtx, examId: string, csId: string, maxMarks: number): Promise<string> {
  const existing = await exists(ctx, `SELECT id FROM exam_subjects WHERE exam_id = ? AND class_subject_id = ?`, examId, csId)
  if (existing) { await ctx.db.prepare(`UPDATE exam_subjects SET max_marks = ? WHERE id = ?`).bind(String(maxMarks), existing).run(); return existing }
  const id = uuid()
  await ctx.db.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks) VALUES (?, ?, ?, ?, ?)`).bind(id, ctx.inst, examId, csId, String(maxMarks)).run()
  return id
}

async function writeMark(ctx: ImportCtx, examSubjectId: string, studentId: string, obtained: string | null, grade: string | null, absent: boolean, keepGrade = false): Promise<void> {
  const existing = await exists(ctx, `SELECT id FROM marks WHERE exam_subject_id = ? AND student_id = ?`, examSubjectId, studentId)
  if (existing) {
    if (keepGrade) await ctx.db.prepare(`UPDATE marks SET marks_obtained = ?, is_absent = ? WHERE id = ?`).bind(obtained, absent ? 1 : 0, existing).run()
    else await ctx.db.prepare(`UPDATE marks SET marks_obtained = ?, grade = ?, is_absent = ? WHERE id = ?`).bind(obtained, grade, absent ? 1 : 0, existing).run()
    return
  }
  const id = uuid()
  await ctx.db.prepare(`INSERT INTO marks (id, institution_id, exam_subject_id, student_id, marks_obtained, grade, is_absent, entered_by, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ctx.inst, examSubjectId, studentId, obtained, grade, absent ? 1 : 0, ctx.c.id.userId, now()).run()
  ctx.noteCreated('marks', id, true)
}

/** One imported punch becomes the day it belongs to: first in, last out, only where a device wrote the day. */
async function rollUpImportedDay(ctx: ImportCtx, empId: string, at: string, serial: string): Promise<void> {
  const onDate = new Date(Date.parse(at) + 330 * 60_000).toISOString().slice(0, 10)
  const dayFrom = istToUTC(onDate, '00:00'), dayTo = istToUTC(onDate, '23:59:59')
  const d = await ctx.db.prepare(`SELECT MIN(p.punched_at) AS first_seen, MAX(p.punched_at) AS last_seen FROM biometric_punches p WHERE p.institution_id = ? AND p.employee_id = ? AND p.punched_at BETWEEN ? AND ?`)
    .bind(ctx.inst, empId, dayFrom, dayTo).first<{ first_seen: string | null; last_seen: string | null }>()
  if (!d?.first_seen) return
  const e = await ctx.db.prepare(`SELECT user_id FROM employees WHERE id = ? AND user_id IS NOT NULL`).bind(empId).first<{ user_id: string }>()
  if (!e) return
  const checkOut = d.last_seen && d.last_seen > d.first_seen ? d.last_seen : null
  const existing = await ctx.db.prepare(`SELECT id, source, check_in, check_out FROM staff_attendance WHERE user_id = ? AND on_date = ?`).bind(e.user_id, onDate)
    .first<{ id: string; source: string; check_in: string | null; check_out: string | null }>()
  if (existing) {
    if (existing.source !== 'device') return
    const inAt = existing.check_in && existing.check_in < d.first_seen ? existing.check_in : d.first_seen
    const outAt = existing.check_out && (!checkOut || existing.check_out > checkOut) ? existing.check_out : checkOut
    await ctx.db.prepare(`UPDATE staff_attendance SET check_in = ?, check_out = ?, status = 'present' WHERE id = ?`).bind(inAt, outAt, existing.id).run()
    return
  }
  await ctx.db.prepare(`INSERT INTO staff_attendance (id, institution_id, user_id, on_date, status, check_in, check_out, source, device_ref, created_at) VALUES (?, ?, ?, ?, 'present', ?, ?, 'device', ?, ?)`)
    .bind(uuid(), ctx.inst, e.user_id, onDate, d.first_seen, checkOut, serial, now()).run()
}

/* --- the engine ----------------------------------------------------------------- */

export function normaliseHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/ /g, '_').replace(/-/g, '_').replace(/^_+|_+$/g, '')
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, ragged rows kept. */
export function parseCSV(text: string): { rows: string[][]; errors: Map<number, string> } {
  const rows: string[][] = []
  const errors = new Map<number, string>()
  let field = '', row: string[] = [], quoted = false, i = 0
  const push = () => { row.push(field); field = '' }
  const end = () => { push(); rows.push(row); row = [] }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue } quoted = false; i++; continue }
      field += ch; i++; continue
    }
    if (ch === '"') { if (field.trim() === '') { field = ''; quoted = true; i++; continue } errors.set(rows.length + 1, 'bare " in non-quoted field'); field += ch; i++; continue }
    if (ch === ',') { push(); i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { end(); i++; continue }
    field += ch; i++
  }
  if (field !== '' || row.length > 0) end()
  if (quoted) errors.set(rows.length, 'extraneous or missing " in quoted-field')
  return { rows, errors }
}

interface ImportRow { row: number; data?: Row; problem?: string }
interface ImportResult { total: number; valid: number; rejected: number; imported: number; dry_run: boolean; problems: ImportRow[]; run_id?: string }

function columnMapFrom(c: Ctx): Record<string, string> | null {
  const raw = (c.req.headers.get('x-column-map') ?? '').trim()
  if (raw === '') return null
  try { const m = JSON.parse(raw); return m && typeof m === 'object' ? (m as Record<string, string>) : null } catch { return null }
}

function sheetFactsFrom(c: Ctx): SheetFacts {
  const q = c.url.searchParams
  const f: SheetFacts = { year: (q.get('year') ?? '').trim(), exam: (q.get('exam') ?? '').trim(), class: (q.get('class') ?? '').trim(),
    from: (q.get('period_from') ?? '').trim(), to: (q.get('period_to') ?? '').trim(), maxMarks: 0 }
  const mm = Number((q.get('max_marks') ?? '').trim())
  if ((q.get('max_marks') ?? '').trim() !== '' && Number.isFinite(mm)) f.maxMarks = mm
  return f
}

function subjectColumnsFrom(c: Ctx): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [ours, theirs] of Object.entries(columnMapFrom(c) ?? {})) {
    if (ours.startsWith('subject:')) {
      const name = ours.slice('subject:'.length).trim()
      if (name !== '' && String(theirs).trim() !== '') out[name] = String(theirs).trim()
    }
  }
  return out
}

const MAX_KEPT_IMPORT_BYTES = 1 << 20

async function runBulkImportCSV(c: Ctx, entity: string, spec: ImportSpec, raw: string, commit: boolean): Promise<{ out: ImportResult; clientMsg: string }> {
  const { rows: records, errors: readErrors } = parseCSV(raw)
  const out: ImportResult = { total: 0, valid: 0, rejected: 0, imported: 0, dry_run: !commit, problems: [] }
  if (records.length === 0) return { out, clientMsg: 'that file has no header row' }
  const head = records[0]
  let index = new Map<string, number>()
  head.forEach((h, i) => index.set(normaliseHeader(h), i))
  const map = columnMapFrom(c)
  if (map && Object.keys(map).length > 0) {
    const remapped = new Map<string, number>()
    for (const [ours, theirs] of Object.entries(map)) {
      const t = String(theirs).trim()
      if (t === '') continue
      const i = index.get(normaliseHeader(t))
      if (i !== undefined) { remapped.set(normaliseHeader(ours), i); continue }
      if (t.startsWith('#')) { const n = Number(t.slice(1)); if (Number.isInteger(n) && n >= 0 && n < head.length) remapped.set(normaliseHeader(ours), n) }
    }
    index = remapped
  }
  for (const need of spec.required) {
    if (!index.has(need)) return { out, clientMsg: `nothing is mapped to ${need}, and a row cannot be built without it. Choose which of your columns holds it.` }
  }

  const parsed: Array<{ row: number; data: Row }> = []
  const seen = new Map<string, number>()
  for (let r = 1; r < records.length; r++) {
    const n = r + 1
    const rec = records[r]
    const readErr = readErrors.get(n)
    if (readErr) { out.total++; out.rejected++; out.problems.push({ row: n, problem: 'could not read this row: ' + readErr }); continue }
    const data: Row = {}
    for (const [col, i] of index) if (i < rec.length) data[col] = rec[i].trim()
    if (Object.values(data).every((v) => v === '')) continue
    if (spec.skip && spec.skip(data)) continue
    out.total++
    const missing = spec.required.find((k) => (data[k] ?? '') === '')
    if (missing) { out.rejected++; out.problems.push({ row: n, data, problem: missing + ' is required' }); continue }
    if (spec.check) {
      try { spec.check(data) } catch (e) { out.rejected++; out.problems.push({ row: n, data, problem: (e as Error).message }); continue }
    }
    if (spec.identity) {
      const key = (data[spec.identity] ?? '').trim().toLowerCase()
      if (key !== '') {
        const first = seen.get(key)
        if (first !== undefined) {
          out.rejected++
          out.problems.push({ row: n, data, problem: `${spec.identity} "${data[spec.identity]}" is already on row ${first} of this file. Two rows cannot be the same person` })
          continue
        }
        seen.set(key, n)
      }
    }
    out.valid++
    parsed.push({ row: n, data })
  }

  let rows = parsed
  const inst = instId(c)
  if (spec.verify && rows.length > 0) {
    const campus = await ensureCampus(c)
    const ctx = new ImportCtx(c, inst, campus, sheetFactsFrom(c), subjectColumnsFrom(c))
    const bad = new Set<number>()
    for (const p of rows) {
      try { await spec.verify(ctx, p.data) } catch (e) {
        out.valid--; out.rejected++
        out.problems.push({ row: p.row, data: p.data, problem: (e as Error).message })
        bad.add(p.row)
      }
    }
    if (bad.size > 0) rows = rows.filter((p) => !bad.has(p.row))
  }
  if (!commit || rows.length === 0) return { out, clientMsg: '' }

  const campus = await ensureCampus(c)
  const ctx = new ImportCtx(c, inst, campus, sheetFactsFrom(c), subjectColumnsFrom(c))
  ctx.year = await workingYearId(c)
  for (const p of rows) {
    const madeSoFar = ctx.created.length
    try {
      await spec.write(ctx, p.data)
      out.imported++
    } catch (e) {
      if (e instanceof HttpError) throw e
      ctx.created.length = madeSoFar
      ctx.forgetCaches()
      out.rejected++
      out.problems.push({ row: p.row, data: p.data, problem: (e as Error).message })
    }
  }
  const runId = uuid()
  const omitted = raw.length > MAX_KEPT_IMPORT_BYTES
  const stmts = [c.db.prepare(`INSERT INTO import_runs (id, institution_id, entity, filename, rows_read, rows_imported, rows_rejected, imported_by, created_at, content, content_omitted)
      VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
    .bind(runId, inst, entity, (c.url.searchParams.get('filename') ?? '').trim(), out.total, out.imported, out.rejected, c.id.userId, now(), omitted ? '' : raw, omitted ? 1 : 0)]
  for (const cr of ctx.created) {
    stmts.push(c.db.prepare(`INSERT OR IGNORE INTO import_run_rows (run_id, institution_id, entity, record_id) VALUES (?, ?, ?, ?)`).bind(runId, inst, cr.entity, cr.id))
  }
  await c.db.batch(stmts)
  out.run_id = runId
  return { out, clientMsg: '' }
}

/* --- history and undo ------------------------------------------------------------ */

const undoableTables: Record<string, string> = {
  classes: 'classes', sections: 'sections', subjects: 'subjects', periods: 'periods', fee_heads: 'fee_heads', students: 'students', staff: 'employees',
  fee_structures: 'fee_structures', class_subjects: 'class_subjects', allocations: 'section_subject_teachers', timetable: 'timetable_entries',
  holidays: 'holidays', student_history: 'student_year_history', staff_history: 'employee_year_history', marks: 'marks', marks_grid: 'marks',
  attendance: 'student_attendance', staff_attendance: 'staff_attendance', fee_payments: 'payments', payslips: 'payslips',
}

const studentIsUntouched = `SELECT NOT EXISTS (SELECT 1 FROM student_attendance a WHERE a.student_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.student_id = ?1) AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM report_cards rc WHERE rc.student_id = ?1) AND NOT EXISTS (SELECT 1 FROM homework_submissions h WHERE h.student_id = ?1) AS untouched`

function permForImportEntity(entity: string): string {
  const spec = importSpecs[entity]
  if (spec) return spec.perm
  return entity === 'students' ? 'students.write' : ''
}

async function tidyPayrollRuns(c: Ctx): Promise<void> {
  await c.db.batch([
    c.db.prepare(`UPDATE payroll_runs SET gross_paise = (SELECT COALESCE(SUM(gross_paise), 0) FROM payslips p WHERE p.payroll_run_id = payroll_runs.id),
        deduction_paise = (SELECT COALESCE(SUM(deduction_paise), 0) FROM payslips p WHERE p.payroll_run_id = payroll_runs.id),
        net_paise = (SELECT COALESCE(SUM(net_paise), 0) FROM payslips p WHERE p.payroll_run_id = payroll_runs.id),
        employees = (SELECT COUNT(*) FROM payslips p WHERE p.payroll_run_id = payroll_runs.id)
        WHERE institution_id = ? AND EXISTS (SELECT 1 FROM payslips p WHERE p.payroll_run_id = payroll_runs.id)`).bind(instId(c)),
    c.db.prepare(`DELETE FROM payroll_runs WHERE institution_id = ? AND run_by IS NULL AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.payroll_run_id = payroll_runs.id)`).bind(instId(c)),
  ])
}

function studentImportFields(): Array<Record<string, unknown>> {
  const f = (name: string, example: string, required: boolean) => ({ name, example, required })
  return [f('full_name', 'Meera Menon', true), f('admission_no', 'ADM0001', false), f('date_of_birth', '14/06/2013', false), f('gender', 'female', false),
    f('blood_group', 'B+', false), f('medium', 'english', false), f('mother_tongue', 'Malayalam', false), f('class', 'Grade 6', false),
    f('section', 'A, or Class 6-A in one cell', false), f('roll_no', '1', false), f('address', '12 Green Park', false), f('city', 'Hyderabad', false),
    f('state', 'Telangana', false), f('pincode', '500001', false), f('prior_school', "St Teresa's", false), f('admission_date', '12/06/2021', false),
    f('previous_class', 'Grade 5', false), f('previous_year', '2025-26', false), f('father_name', 'Suresh Menon', false), f('father_phone', '9845012345', false),
    f('father_email', 'suresh@example.com', false), f('mother_name', 'Latha Menon', false), f('mother_phone', '9845067890', false), f('mother_email', 'latha@example.com', false),
    f('guardian_name', 'Anyone else on the record', false), f('guardian_relation', 'grandfather', false), f('guardian_phone', '9845011111', false), f('guardian_email', 'guardian@example.com', false)]
}

const csvLine = (cells: string[]): string => cells.map((v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',') + '\n'

export function registerImports(r: Router): void {
  r.get('/setup/import/history', 'auth', async (c) => {
    requireInstitution(c)
    const entity = nullStr(c.url.searchParams.get('entity'))
    const rows = await c.db.prepare(`SELECT ir.id, ir.entity, ir.filename, ir.rows_read, ir.rows_imported, ir.rows_rejected, u.full_name AS imported_by, ir.created_at, ir.undone_at,
        (SELECT COUNT(*) FROM import_run_rows w WHERE w.run_id = ir.id) AS created_rows FROM import_runs ir LEFT JOIN users u ON u.id = ir.imported_by
        WHERE (? IS NULL OR ir.entity = ?) ORDER BY ir.created_at DESC LIMIT 50`).bind(entity, entity).all<Record<string, unknown>>()
    const stamp = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 19))
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, entity: v.entity }
      if (v.filename !== null) o.filename = v.filename
      o.rows_read = Number(v.rows_read); o.rows_imported = Number(v.rows_imported); o.rows_rejected = Number(v.rows_rejected)
      if (v.imported_by !== null) o.imported_by = v.imported_by
      o.created_at = stamp(v.created_at)
      if (v.undone_at !== null) o.undone_at = stamp(v.undone_at)
      o.created_rows = Number(v.created_rows)
      return o
    })
    return ok({ items })
  })

  r.post('/setup/import/history/{id}/undo', 'auth', async (c) => {
    requireInstitution(c)
    const runId = uuidParam(c.params.id)
    const run = await c.db.prepare(`SELECT entity, undone_at FROM import_runs WHERE id = ?`).bind(runId).first<{ entity: string; undone_at: string | null }>()
    if (!run) throw notFound('resource not found')
    if (run.undone_at) throw badRequest('that upload has already been undone')
    const need = permForImportEntity(run.entity)
    if (need === '' || !can(c.id, need)) throw forbidden('missing permission: undoing this kind of import')
    const targets = await c.db.prepare(`SELECT entity, record_id FROM import_run_rows WHERE run_id = ?`).bind(runId).all<{ entity: string; record_id: string }>()
    const out = { removed: 0, kept: 0, reasons: [] as string[] }
    const reason = (s: string) => { if (out.reasons.length < 5) out.reasons.push(s) }
    for (const t of targets.results) {
      const table = undoableTables[t.entity]
      if (!table) { out.kept++; continue }
      if (t.entity === 'staff') {
        const busy = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM section_subject_teachers t JOIN employees e ON e.user_id = t.teacher_user_id WHERE e.id = ?1)
            OR EXISTS (SELECT 1 FROM sections s JOIN employees e ON e.user_id = s.class_teacher_id WHERE e.id = ?1) AS busy`).bind(t.record_id).first<{ busy: number }>()
        if (busy?.busy) { out.kept++; reason('a teacher is assigned to a class or subject and was left alone'); continue }
      }
      if (t.entity === 'students') {
        const u = await c.db.prepare(studentIsUntouched).bind(t.record_id).first<{ untouched: number }>()
        if (!u?.untouched) { out.kept++; reason('a child already has attendance, marks or fees recorded and was left alone'); continue }
      }
      try {
        await c.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(t.record_id).run()
        out.removed++
      } catch {
        out.kept++
        reason('one ' + t.entity + ' row is still in use and was left alone')
      }
    }
    try { await tidyPayrollRuns(c) } catch { /* as Go: best effort */ }
    if (out.removed > 0) await c.db.prepare(`UPDATE import_runs SET undone_at = ?, undone_by = ? WHERE id = ?`).bind(now(), c.id.userId, runId).run()
    return ok(out)
  })

  r.get('/setup/import/history/{id}/content', 'auth', async (c) => {
    requireInstitution(c)
    const runId = uuidParam(c.params.id)
    const run = await c.db.prepare(`SELECT entity, filename, content, content_omitted FROM import_runs WHERE id = ?`).bind(runId)
      .first<{ entity: string; filename: string | null; content: string | null; content_omitted: number }>()
    if (!run) throw notFound('resource not found')
    const need = permForImportEntity(run.entity)
    if (need === '' || !can(c.id, need)) throw forbidden('missing permission: reading this upload')
    return ok({ entity: run.entity, filename: run.filename, content: run.content ?? '', omitted: !!run.content_omitted })
  })

  r.get('/setup/import/{entity}/template', 'auth', (c) => {
    const entity = c.params.entity
    const spec = importSpecs[entity]
    if (!spec) throw badRequest('nothing can be imported as ' + entity)
    if (!can(c.id, spec.perm)) throw new HttpError(403, 'you cannot import ' + entity, { code: 'forbidden' })
    let body = csvLine(spec.columns)
    if (spec.sample.length === spec.columns.length) body += csvLine(spec.sample)
    return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${entity}-template.csv"`, 'cache-control': 'no-store, must-revalidate' } })
  })

  r.get('/setup/import/{entity}/fields', 'auth', (c) => {
    const entity = c.params.entity
    if (entity === 'students') return ok({ fields: studentImportFields() })
    const spec = importSpecs[entity]
    if (!spec) throw badRequest('nothing can be imported as ' + entity)
    if (!can(c.id, spec.perm)) throw new HttpError(403, 'you cannot import ' + entity, { code: 'forbidden' })
    const required = new Set(spec.required)
    const fields = spec.columns.map((col, i) => {
      const f: Record<string, unknown> = { name: col, required: required.has(col) }
      if (i < spec.sample.length) f.example = spec.sample[i]
      return f
    })
    return ok({ fields })
  })

  r.post('/setup/import/{entity}', 'auth', async (c) => {
    requireInstitution(c)
    const entity = c.params.entity
    const spec = importSpecs[entity]
    if (!spec) throw badRequest('nothing can be imported as ' + entity)
    if (!can(c.id, spec.perm)) throw new HttpError(403, 'you cannot import ' + entity, { code: 'forbidden' })
    const commit = c.url.searchParams.get('commit') === 'true'
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength > 8 << 20) throw badRequest('could not read the file. Is it larger than 8 MB?')
    const raw = new TextDecoder('utf-8').decode(bytes)
    const { out, clientMsg } = await runBulkImportCSV(c, entity, spec, raw, commit)
    if (clientMsg !== '') throw badRequest(clientMsg)
    return ok(out)
  })
}

