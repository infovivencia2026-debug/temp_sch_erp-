import type { Llm } from './gemini_seam'
import { parseJsonReply } from './gemini_seam'

/* Smart import: from any table (a CSV, an .xlsx, or a photo transcribed and
   then reviewed by a person) to the exact CSV one of the existing importers
   reads. This file is pure apart from the Llm it is handed:

   - proposeImport: which import kind the table is and which column feeds
     which importer field, each with a confidence. Gemini when there is a key,
     checked against the real field list; a header-matching heuristic always
     runs and fills in (or stands in) when the model is absent or wrong.
   - normaliseRows: dates to YYYY-MM-DD (Excel serials too), class names
     like "VI-A" / "Std 6 A" / "6th B" to the school's own class + section,
     Indian phone numbers to 10 digits, gender and attendance words.
   - extractTableFromImage: Gemini vision transcribes a photo into rows for
     a person to check; nothing from a photo is imported unreviewed (the
     route refuses a commit without `reviewed`).

   The importer (routes/setup/imports.ts) still does all validation and
   permissions; this only prepares its input. */

export interface ImportKind { key: string; label: string; columns: string[]; required: string[] }
export interface Table { headers: string[]; rows: string[][] }
export interface ColumnMap { header: string; index: number; field: string | null; confidence: number; source: 'ai' | 'rule' | 'user' }
export interface Proposal { kind: string; kind_confidence: number; alternatives: { kind: string; score: number }[]; mapping: ColumnMap[]; notes: string[]; by: 'ai' | 'rule' }

export const norm = (h: string) => h.replace(/^﻿/, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** What offices call each importer field. Keys are importer column names. */
const SYNONYMS: Record<string, string[]> = {
  full_name: ['name', 'student name', 'name of student', 'student', 'pupil name', 'name of the student', 'childs name', 'child name'],
  first_name: ['first name', 'given name', 'fname'],
  last_name: ['last name', 'surname', 'family name', 'lname'],
  name: ['name', 'title'],
  admission_no: ['adm no', 'admission no', 'admission number', 'adm', 'admn no', 'sr no', 'scholar no', 'gr no', 'enrollment no', 'enrolment no', 'reg no', 'registration no'],
  date_of_birth: ['dob', 'birth date', 'date of birth', 'd o b', 'birthday'],
  gender: ['sex', 'gender', 'm f', 'boy girl'],
  class: ['class', 'std', 'standard', 'grade', 'class section', 'class sec', 'cls'],
  section: ['section', 'sec', 'div', 'division'],
  roll_no: ['roll', 'roll no', 'roll number', 'r no'],
  father_name: ['father', 'fathers name', 'father name', 'fname father'],
  father_phone: ['father mobile', 'fathers mobile', 'father phone', 'fathers phone', 'phone', 'mobile', 'contact', 'contact no', 'mobile no', 'phone no', 'parent mobile'],
  mother_name: ['mother', 'mothers name', 'mother name'],
  mother_phone: ['mother mobile', 'mothers mobile', 'mother phone'],
  address: ['address', 'residential address', 'addr'],
  admission_date: ['doa', 'date of admission', 'admission date', 'joined on'],
  blood_group: ['blood group', 'blood grp', 'bg'],
  employee_code: ['emp code', 'employee code', 'staff code', 'staff id', 'employee id', 'emp id', 'emp no'],
  email: ['email', 'e mail', 'mail id', 'email id'],
  phone: ['phone', 'mobile', 'contact', 'mobile no', 'phone no'],
  designation: ['designation', 'post', 'position', 'role title'],
  department: ['department', 'dept'],
  joined_on: ['doj', 'date of joining', 'joining date', 'joined on'],
  date: ['date', 'day', 'on', 'attendance date'],
  status: ['status', 'attendance', 'p a', 'present absent', 'present'],
  remarks: ['remarks', 'remark', 'note', 'notes', 'comment'],
  exam: ['exam', 'exam name', 'test', 'assessment', 'term'],
  subject: ['subject', 'subject name', 'sub'],
  max_marks: ['max marks', 'max', 'out of', 'total marks', 'maximum marks', 'mm', 'full marks'],
  marks_obtained: ['marks', 'marks obtained', 'score', 'obtained', 'mo', 'marks scored'],
  grade: ['grade', 'grd'],
  year: ['year', 'academic year', 'session'],
  amount: ['amount', 'amount paid', 'paid', 'fee paid', 'rs', 'amt'],
  paid_on: ['paid on', 'payment date', 'date of payment', 'receipt date', 'date'],
  receipt_no: ['receipt', 'receipt no', 'receipt number', 'rcpt no'],
  mode: ['mode', 'payment mode', 'pay mode', 'cash cheque'],
  code: ['code', 'short code'],
  teacher: ['teacher', 'faculty', 'teacher name'],
  day: ['day', 'weekday'],
  period: ['period', 'period no', 'pd'],
  event: ['event', 'holiday', 'occasion', 'reason'],
  check_in: ['in', 'in time', 'check in', 'time in'],
  check_out: ['out', 'out time', 'check out', 'time out'],
}

function headerScore(header: string, field: string): number {
  const h = norm(header), f = norm(field.replace(/_/g, ' '))
  if (h === '' ) return 0
  if (h === f) return 1
  const syn = SYNONYMS[field] ?? []
  if (syn.includes(h)) return 0.92
  if (syn.some((s) => s.length > 2 && (h.startsWith(s + ' ') || h.endsWith(' ' + s)))) return 0.75
  if (f.length > 3 && (h.includes(f) || f.includes(h))) return 0.7
  const ht = new Set(h.split(' ')), ft = new Set([...f.split(' '), ...syn.flatMap((s) => s.split(' '))])
  const shared = [...ht].filter((t) => t.length > 1 && ft.has(t)).length
  return shared > 0 ? Math.min(0.6, 0.3 * shared) : 0
}

/** Greedy best-first assignment of headers to fields (one field per header, one header per field). */
export function heuristicMapping(headers: string[], kind: ImportKind): ColumnMap[] {
  const pairs: { i: number; field: string; s: number }[] = []
  headers.forEach((h, i) => kind.columns.forEach((field) => { const s = headerScore(h, field); if (s >= 0.3) pairs.push({ i, field, s }) }))
  pairs.sort((a, b) => b.s - a.s || kind.columns.indexOf(a.field) - kind.columns.indexOf(b.field))
  const usedH = new Set<number>(), usedF = new Set<string>()
  const out: ColumnMap[] = headers.map((header, index) => ({ header, index, field: null, confidence: 0, source: 'rule' }))
  for (const p of pairs) {
    if (usedH.has(p.i) || usedF.has(p.field)) continue
    usedH.add(p.i); usedF.add(p.field)
    out[p.i].field = p.field
    out[p.i].confidence = Math.round(p.s * 100) / 100
  }
  return out
}

export function scoreKind(headers: string[], kind: ImportKind): number {
  const m = heuristicMapping(headers, kind)
  const got = new Map(m.filter((x) => x.field).map((x) => [x.field!, x.confidence]))
  const req = kind.required.length ? kind.required.reduce((a, f) => a + (got.get(f) ?? 0), 0) / kind.required.length : 0.5
  const cover = [...got.values()].reduce((a, b) => a + b, 0) / Math.max(headers.filter((h) => h.trim() !== '').length, 1)
  return Math.round((0.6 * req + 0.4 * Math.min(cover, 1)) * 100) / 100
}

export function heuristicProposal(t: Table, kinds: ImportKind[], forced?: string): Proposal {
  const ranked = kinds.map((k) => ({ kind: k.key, score: scoreKind(t.headers, k) })).sort((a, b) => b.score - a.score)
  const pick = kinds.find((k) => k.key === forced) ?? kinds.find((k) => k.key === ranked[0]?.kind) ?? kinds[0]
  return { kind: pick.key, kind_confidence: ranked.find((r) => r.kind === pick.key)?.score ?? 0, alternatives: ranked.slice(0, 4),
    mapping: heuristicMapping(t.headers, pick), notes: [], by: 'rule' }
}

const PROPOSE_SYSTEM = `You help a school office import a spreadsheet into their school ERP.
You get the sheet's headers, a few sample rows, and the list of import kinds with their field names.
Decide which ONE import kind the sheet holds and map each header to one field of that kind (or null if no field fits).
Never map two headers to the same field. Use only field names from the chosen kind. Confidence is 0..1.
Answer with JSON only:
{"kind":"<key>","confidence":0.0,"mapping":[{"header":"<exact header>","field":"<field or null>","confidence":0.0}],"notes":["<short note for the user>"]}`

/** Gemini's proposal, validated against the real fields and merged with the heuristic. */
export async function proposeImport(llm: Llm | null, t: Table, kinds: ImportKind[], forced?: string): Promise<Proposal> {
  const base = heuristicProposal(t, kinds, forced)
  if (!llm) return base
  let reply: string
  try {
    const catalogue = kinds.map((k) => ({ key: k.key, label: k.label, fields: k.columns, required: k.required }))
    const prompt = JSON.stringify({ headers: t.headers, sample_rows: t.rows.slice(0, 8), kinds: forced ? catalogue.filter((k) => k.key === forced) : catalogue })
    reply = await llm(PROPOSE_SYSTEM, [{ text: prompt }], 2048)
  } catch (e) {
    console.error('smart import: model unavailable, using header rules', e)
    return { ...base, notes: ['The AI was unavailable, so columns were matched by their names.'] }
  }
  const p = parseJsonReply<{ kind?: string; confidence?: number; mapping?: { header?: string; field?: string | null; confidence?: number }[]; notes?: unknown[] }>(reply)
  const kind = kinds.find((k) => k.key === (forced ?? p?.kind))
  if (!p || !kind || !Array.isArray(p.mapping)) return { ...base, notes: ['The AI answer could not be used, so columns were matched by their names.'] }
  const rule = forced === kind.key || base.kind === kind.key ? base.mapping : heuristicMapping(t.headers, kind)
  const used = new Set<string>()
  const mapping: ColumnMap[] = t.headers.map((header, index) => ({ header, index, field: null, confidence: 0, source: 'ai' as const }))
  // Most confident first, so a doubtful duplicate never displaces a sure answer.
  const answers = p.mapping.filter((x) => x && typeof x.header === 'string').sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence))
  for (const m of answers) {
    const i = t.headers.indexOf(m.header!)
    if (i < 0 || mapping[i].field || !m.field || !kind.columns.includes(m.field) || used.has(m.field)) continue
    used.add(m.field)
    mapping[i] = { header: m.header!, index: i, field: m.field, confidence: clamp01(m.confidence), source: 'ai' }
  }
  // Where the model left a header unmapped but the rules are sure, keep the rule's answer.
  for (const r of rule) if (r.field && r.confidence >= 0.9 && !mapping[r.index].field && !used.has(r.field)) { mapping[r.index] = { ...r }; used.add(r.field) }
  const notes = Array.isArray(p.notes) ? p.notes.filter((n): n is string => typeof n === 'string').slice(0, 5) : []
  return { kind: kind.key, kind_confidence: clamp01(p.confidence), alternatives: base.alternatives, mapping, notes, by: 'ai' }
}
const clamp01 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 100) / 100)) : 0.5 }

// ---- normalisation ----------------------------------------------------------------

export interface SchoolClass { name: string; level: number | null }
export interface Change { row: number; field: string; from: string; to: string }

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 }
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 }
const PRE: Record<string, number> = { nursery: -2, pre: -2, prenursery: -3, playgroup: -3, lkg: -1, pp1: -1, ukg: 0, pp2: 0, kg: 0 }

/** "VI-A" -> {level 6, section A}; "Std 10 B", "6th", "Class XII Sci", "UKG-B". Null when it is not a class. */
export function parseClassCell(v: string): { level: number; section: string | null; raw: string } | null {
  const s = v.trim().toLowerCase().replace(/\s+/g, ' ')
  if (s === '') return null
  const m = s.match(/^(?:class|std|standard|grade|gr|cl|stage)?\.?\s*([a-z]+|\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:[-/ ]|\bsec(?:tion)?\b|\bdiv\b)\s*([a-z]|\d))?$/i)
  if (!m) return null
  const tok = m[1]
  let level: number | undefined
  if (/^\d+$/.test(tok)) level = Number(tok)
  else level = ROMAN[tok] ?? WORDS[tok] ?? PRE[tok]
  if (level === undefined || level > 12) return null
  return { level, section: m[2] ? m[2].toUpperCase() : null, raw: v }
}

function classNameFor(level: number, classes: SchoolClass[]): string {
  const hit = classes.find((c) => c.level === level)
  if (hit) return hit.name
  if (level === -1) return 'LKG'
  if (level === 0) return 'UKG'
  if (level < -1) return 'Nursery'
  return 'Grade ' + level
}

/** Excel serial (days since 1899-12-30) or any common written date -> YYYY-MM-DD; '' if unreadable. */
export function toIsoDate(v: string): string {
  const s = v.trim()
  if (s === '') return ''
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10)
  }
  const valid = (y: number, m: number, d: number) => {
    if (y < 100) y += y > 50 ? 1900 : 2000
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y > 1900 && y < 2100 ? dt.toISOString().slice(0, 10) : ''
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/)
  if (m) return valid(+m[3], +m[2], +m[1]) || valid(+m[3], +m[1], +m[2]) // India writes day first
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[- ,]*([a-z]{3,})[- ,.]*(\d{2}|\d{4})$/i)
  if (m && MON.includes(m[2].slice(0, 3).toLowerCase())) return valid(+m[3], MON.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1])
  m = s.match(/^([a-z]{3,})\.? (\d{1,2}),? (\d{4})$/i)
  if (m && MON.includes(m[1].slice(0, 3).toLowerCase())) return valid(+m[3], MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2])
  return ''
}

/** +91 98450-12345, 098450 12345, 919845012345 -> 9845012345. Unchanged when it is not an Indian mobile/landline shape. */
export function normalisePhone(v: string): string {
  const d = v.replace(/\.0+$/, '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) return d.slice(2)
  if (d.length === 11 && d.startsWith('0')) return d.slice(1)
  if (d.length === 10) return d
  return v.trim()
}

const isDateField = (f: string) => /(^|_)(date|dob|on)$|^date_|^date$|^to$|date_of_birth/.test(f)
const isPhoneField = (f: string) => /phone|mobile/.test(f)

function normaliseValue(kind: string, field: string, v: string): string {
  const t = v.trim()
  if (t === '') return ''
  if (isDateField(field)) return toIsoDate(t) || t
  if (isPhoneField(field)) return normalisePhone(t)
  if (field === 'gender') {
    const g = t.toLowerCase()
    if (['m', 'male', 'boy', 'b'].includes(g)) return 'male'
    if (['f', 'female', 'girl', 'g'].includes(g)) return 'female'
    return t
  }
  if (field === 'status' && (kind === 'attendance' || kind === 'staff_attendance')) {
    const s = t.toLowerCase()
    const map: Record<string, string> = { p: 'present', '✓': 'present', '/': 'present', a: 'absent', ab: 'absent', x: 'absent', l: 'late', h: 'holiday', lv: 'leave', le: 'leave', hd: 'half_day' }
    return map[s] ?? s
  }
  if (field === 'amount' || field === 'marks_obtained' || field === 'max_marks') return t.replace(/^(rs\.?|₹|inr)\s*/i, '').replace(/,/g, '').replace(/\/-$/, '')
  return t
}

/** Mapped + normalised rows as {field: value}, plus the list of every change made (for the preview). */
export function normaliseRows(kind: ImportKind, t: Table, mapping: ColumnMap[], classes: SchoolClass[]): { rows: Record<string, string>[]; changes: Change[]; sourceRows: number[] } {
  const changes: Change[] = []
  const rows: Record<string, string>[] = []
  const sourceRows: number[] = []
  const hasSection = kind.columns.includes('section')
  const sectionMapped = mapping.some((m) => m.field === 'section')
  t.rows.forEach((r, ri) => {
    const out: Record<string, string> = {}
    for (const m of mapping) {
      if (!m.field || !kind.columns.includes(m.field)) continue
      const raw = String(r[m.index] ?? '')
      let v = normaliseValue(kind.key, m.field, raw)
      if (m.field === 'class' && raw.trim() !== '') {
        const pc = parseClassCell(raw)
        if (pc) {
          v = classNameFor(pc.level, classes)
          if (pc.section && hasSection) {
            const cur = sectionMapped ? String(r[mapping.find((x) => x.field === 'section')!.index] ?? '').trim() : ''
            if (cur === '') { out.section = pc.section; changes.push({ row: ri, field: 'section', from: '', to: pc.section }) }
          }
        }
      }
      if (out[m.field] === undefined || out[m.field] === '') out[m.field] = v
      if (v !== raw.trim()) changes.push({ row: ri, field: m.field, from: raw, to: v })
    }
    if (Object.values(out).some((x) => x !== '')) { rows.push(out); sourceRows.push(ri) }
  })
  return { rows, changes, sourceRows }
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)

/** The importer's CSV: header row of the fields in play, in the importer's column order. */
export function toImporterCSV(kind: ImportKind, rows: Record<string, string>[]): string {
  const fields = kind.columns.filter((c) => rows.some((r) => r[c] !== undefined))
  return [fields, ...rows.map((r) => fields.map((f) => r[f] ?? ''))].map((l) => l.map(csvCell).join(',')).join('\n') + '\n'
}

/** A grid (first non-empty row = headers) to a Table; drops fully blank rows. */
export function gridToTable(grid: string[][]): Table {
  const rows = grid.map((r) => r.map((c) => String(c ?? '').trim()))
  const start = rows.findIndex((r) => r.filter((c) => c !== '').length >= 2)
  if (start < 0) return { headers: [], rows: [] }
  const headers = rows[start].map((h, i) => h || `Column ${i + 1}`)
  const body = rows.slice(start + 1).filter((r) => r.some((c) => c !== '')).map((r) => headers.map((_, i) => r[i] ?? ''))
  return { headers, rows: body }
}

// ---- photos -------------------------------------------------------------------------

const OCR_SYSTEM = `You transcribe photos of school paper records (attendance registers, marks sheets, class lists, fee registers).
Copy the table exactly as written: do not correct, guess, total or translate. Keep the column headers as written.
For attendance registers with one column per date, keep one column per date with the date (or day number) as the header.
If a cell cannot be read, put "" and list it in "uncertain" as [rowIndex, columnIndex] (0-based, rows exclude the header).
Answer with JSON only: {"headers":["..."],"rows":[["..."]],"uncertain":[[0,1]],"notes":"<one short line about the photo>"}`

export interface ExtractedTable extends Table { uncertain: [number, number][]; notes: string }

export async function extractTableFromImage(llm: Llm, base64: string, mimeType: string): Promise<ExtractedTable> {
  const reply = await llm(OCR_SYSTEM, [{ inlineData: { mimeType, data: base64 } }, { text: 'Transcribe the table in this photo.' }], 8192)
  const p = parseJsonReply<{ headers?: unknown[]; rows?: unknown[][]; uncertain?: unknown[]; notes?: unknown }>(reply)
  if (!p || !Array.isArray(p.headers) || !Array.isArray(p.rows)) throw new Error('could not read a table from that photo')
  const headers = p.headers.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`)
  const rows = p.rows.filter(Array.isArray).map((r) => headers.map((_, i) => (r[i] === null || r[i] === undefined ? '' : String(r[i]).trim())))
  const uncertain = (Array.isArray(p.uncertain) ? p.uncertain : [])
    .filter((u): u is [number, number] => Array.isArray(u) && u.length === 2 && Number.isInteger(u[0]) && Number.isInteger(u[1])).slice(0, 2000)
  return { headers, rows, uncertain, notes: typeof p.notes === 'string' ? p.notes.slice(0, 300) : '' }
}
