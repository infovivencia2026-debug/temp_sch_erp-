/* The marks sheet: the file Marks entry hands out, and reading it back.

   Owner, 2026-10-13: "click download -> a file with every child -> fill it ->
   upload that same file unchanged". So the template and the reader live
   together, and the one rule they share is that the file the Template button
   wrote goes back in with nothing edited but the marks.

   Kept free of React and the DOM so the worker's integration tests can build
   a template from the real API, fill it, read it back and save it the way the
   screen does. */

export interface SheetPart { id: string; name: string; max_marks: number }
export interface SheetRow {
  student_id: string
  admission_no: string
  full_name: string
  section?: string | null
  roll_no?: string | number | null
  marks_obtained?: number | null
  is_absent?: boolean
  max_marks: number
}
export interface SheetPaper { class_name: string; subject: string; exam_name: string; max_marks: number }

/** Written for an absent child, and read back as absent. */
export const ABSENT = 'AB'

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  if (/["\n\r,]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** A column heading matched loosely: "Project (10)", "project", " PROJECT "
    are the same column. */
export function sameHeading(a: string, b: string): boolean {
  const tidy = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '')
  return tidy(a) !== '' && tidy(a) === tidy(b)
}

/** The template: who each child is, then one empty-or-filled column per part
    (or one Marks column), pre-filled with what is already recorded. */
export function marksTemplate(
  paper: SheetPaper, rows: SheetRow[], parts: SheetPart[],
  saved: Map<string, Record<string, number | null>> = new Map(),
): string {
  const head = ['Admission no.', 'Student', 'Section', 'Class', 'Subject', 'Exam',
    ...(parts.length ? parts.map((p) => `${p.name} (${p.max_marks})`) : [`Marks (${paper.max_marks})`]),
    'Total']
  const body = rows.map((r) => {
    const marks = r.is_absent
      ? (parts.length ? parts.map(() => ABSENT) : [ABSENT])
      : parts.length
        ? parts.map((p) => { const v = saved.get(r.student_id)?.[p.id]; return v == null ? '' : v })
        : [r.marks_obtained ?? '']
    return [r.admission_no, r.full_name, r.section ?? '', paper.class_name, paper.subject, paper.exam_name,
      ...marks, r.is_absent ? '' : (r.marks_obtained ?? '')]
  })
  return '\ufeff' + [head, ...body].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** CSV with quoted cells, doubled quotes and a BOM, as Excel writes it. */
export function parseCSV(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], cur = '', q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((c) => c.trim() !== '')) out.push(row)
      row = []
    } else cur += ch
  }
  row.push(cur)
  if (row.some((c) => c.trim() !== '')) out.push(row)
  return out.map((r) => r.map((c) => c.trim().replace(/^'(?=[=+\-@])/, '')))
}

export interface SheetRead {
  /** Paper with no parts: student -> mark typed. */
  marks: Record<string, string>
  /** Paper in parts: student -> part -> mark typed. */
  parts: Record<string, Record<string, string>>
  absent: Record<string, boolean>
  filled: number
  partColumns: number
  /** Rows that matched nobody on this paper. */
  missed: string[]
  /** Rows refused, each saying whose and why. */
  errors: string[]
}

const isAbsentCell = (v: string) => /^(ab|a|absent)$/i.test(v)

/** Reads a filled sheet against the children on the paper. A blank cell is
    "not entered" and leaves whatever is recorded alone. */
export function readMarksSheet(text: string, rows: SheetRow[], parts: SheetPart[], paperMax: number): SheetRead {
  const res: SheetRead = { marks: {}, parts: {}, absent: {}, filled: 0, partColumns: 0, missed: [], errors: [] }
  const lines = parseCSV(text)
  if (!lines.length) return res
  const header = lines[0].map((h) => h.toLowerCase())
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)))

  let idCol = find('admission', 'adm no', 'adm_no', 'roll')
  let nameCol = find('name', 'student')
  let markCol = find('mark', 'score', 'obtained')
  let body = lines.slice(1)
  if (idCol < 0 && nameCol < 0 && markCol < 0) { idCol = 0; markCol = lines[0].length - 1; body = lines }
  if (markCol < 0) markCol = lines[0].length - 1

  const partCol = new Map<string, number>()
  for (const p of parts) {
    const i = header.findIndex((h) => sameHeading(h, p.name))
    if (i >= 0) partCol.set(p.id, i)
  }
  res.partColumns = partCol.size

  const byAdm = new Map(rows.map((r) => [r.admission_no.toLowerCase(), r]))
  const byName = new Map(rows.map((r) => [r.full_name.trim().toLowerCase(), r]))
  const num = (v: string, max: number, who: string, what: string): boolean => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) { res.errors.push(`${who}: ${what} "${v}" is not a mark`); return false }
    if (n > max) { res.errors.push(`${who}: ${what} ${v} is more than ${max}`); return false }
    return true
  }

  for (const cells of body) {
    const key = ((idCol >= 0 ? cells[idCol] : '') || (nameCol >= 0 ? cells[nameCol] : '') || '').trim()
    if (!key) continue
    const row = byAdm.get(key.toLowerCase()) ?? byName.get(key.toLowerCase())
      ?? (nameCol >= 0 ? byName.get((cells[nameCol] ?? '').trim().toLowerCase()) : undefined)
    if (!row) { res.missed.push(key); continue }
    const who = `${row.full_name} (${row.admission_no})`

    if (partCol.size) {
      const vals = [...partCol].map(([pid, i]) => [pid, (cells[i] ?? '').trim()] as const)
      if (vals.some(([, v]) => v !== '') && vals.every(([, v]) => v === '' || isAbsentCell(v))) {
        res.absent[row.student_id] = true; res.filled++; continue
      }
      const mine: Record<string, string> = {}
      let ok = true
      for (const [pid, v] of vals) {
        if (v === '') continue
        const p = parts.find((x) => x.id === pid)!
        if (!num(v, p.max_marks, who, p.name)) { ok = false; continue }
        mine[pid] = v
      }
      if (ok && Object.keys(mine).length) {
        res.parts[row.student_id] = mine
        if (row.is_absent) res.absent[row.student_id] = false
        res.filled++
      }
      continue
    }
    const v = (cells[markCol] ?? '').trim()
    if (v === '') continue
    if (isAbsentCell(v)) { res.absent[row.student_id] = true; res.filled++; continue }
    if (!num(v, row.max_marks || paperMax, who, 'mark')) continue
    res.marks[row.student_id] = v
    if (row.is_absent) res.absent[row.student_id] = false
    res.filled++
  }
  return res
}

/* ---------------------------------------------------------------------------
   The whole-class sheet (owner, 2026-10-13): one row per child, every subject
   of the class in the exam side by side -- one column per subject, or one per
   part where the exam is marked in parts -- so the class teacher fills one
   file for the exam instead of one per paper.
   --------------------------------------------------------------------------- */

export interface ClassPaper {
  id: string
  subject: string
  max_marks: number
  parts: SheetPart[]
  rows: SheetRow[]
  saved?: Map<string, Record<string, number | null>>
}

/** The key a cell is stored under: the part id, or '_' for a paper's one figure. */
export const ONE = '_'

export interface ClassColumn { paper: ClassPaper; key: string; max: number; heading: string }

export function classColumns(papers: ClassPaper[]): ClassColumn[] {
  const out: ClassColumn[] = []
  for (const p of papers) {
    if (p.parts.length) for (const pt of p.parts) out.push({ paper: p, key: pt.id, max: pt.max_marks, heading: `${p.subject} · ${pt.name} (${pt.max_marks})` })
    else out.push({ paper: p, key: ONE, max: p.max_marks, heading: `${p.subject} · Marks (${p.max_marks})` })
  }
  return out
}

/** Every child on any of the papers, once: section by section, then by roll
    number (1, 2, 3…) as a class register is read (owner, 2026-10-14); a child
    without a roll number goes last in their section, by admission number. */
export function classStudents(papers: ClassPaper[]): SheetRow[] {
  const by = new Map<string, SheetRow>()
  for (const p of papers) for (const r of p.rows) if (!by.has(r.student_id)) by.set(r.student_id, r)
  const roll = (r: SheetRow) => { const n = Number(r.roll_no); return r.roll_no == null || r.roll_no === '' || !Number.isFinite(n) ? Infinity : n }
  return [...by.values()].sort((a, b) =>
    (a.section ?? '').localeCompare(b.section ?? '', undefined, { numeric: true })
    || roll(a) - roll(b)
    || a.admission_no.localeCompare(b.admission_no, undefined, { numeric: true }))
}

/** What is recorded for one cell, as the sheet writes it. */
export function recordedCell(p: ClassPaper, sid: string, key: string): string {
  const row = p.rows.find((r) => r.student_id === sid)
  if (!row) return ''
  if (row.is_absent) return ABSENT
  if (key === ONE) return row.marks_obtained == null ? '' : String(row.marks_obtained)
  const v = p.saved?.get(sid)?.[key]
  return v == null ? '' : String(v)
}

/** The whole-class sheet's columns, subject by subject: its parts, then its
    Total (left as recorded; the importer never reads it). */
export function classTemplate(meta: { class_name: string; exam_name: string }, papers: ClassPaper[]): string {
  const head = ['Roll no', 'Student name', 'Class', 'Section', 'Admission no']
  for (const p of papers) {
    const S = p.subject.toUpperCase()
    if (p.parts.length) { for (const pt of p.parts) head.push(`${S} · ${pt.name} (${pt.max_marks})`); head.push(`${S} · Total (${p.max_marks})`) }
    else head.push(`${S} · Marks (${p.max_marks})`)
  }
  const body = classStudents(papers).map((s) => {
    const line: (string | number)[] = [s.roll_no ?? '', s.full_name, meta.class_name, s.section ?? '', s.admission_no]
    for (const p of papers) {
      const keys = p.parts.length ? p.parts.map((x) => x.id) : [ONE]
      for (const k of keys) line.push(recordedCell(p, s.student_id, k))
      if (p.parts.length) {
        const r = p.rows.find((x) => x.student_id === s.student_id)
        line.push(r && !r.is_absent && r.marks_obtained != null ? r.marks_obtained : '')
      }
    }
    return line
  })
  return '\ufeff' + [head, ...body].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'
}

export interface ClassRead {
  /** paper -> student -> key -> typed value ('AB' for absent). */
  cells: Record<string, Record<string, Record<string, string>>>
  filled: number
  columns: number
  missed: string[]
  errors: string[]
}

/** Reads a filled whole-class sheet. A blank cell is "not entered"; AB is
    absent for that subject; a number out of range is named and not loaded. */
export function readClassSheet(text: string, papers: ClassPaper[]): ClassRead {
  const res: ClassRead = { cells: {}, filled: 0, columns: 0, missed: [], errors: [] }
  const lines = parseCSV(text)
  if (!lines.length) return res
  const header = lines[0]
  const tidy = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '')
  const cols = classColumns(papers)
  const at = new Map<ClassColumn, number>()
  for (const c of cols) {
    const want = tidy(c.heading)
    const i = header.findIndex((h) => tidy(h) === want)
    if (i >= 0) at.set(c, i)
  }
  res.columns = at.size
  const lower = header.map((h) => h.toLowerCase())
  const idCol = lower.findIndex((h) => h.includes('admission'))
  const rollCol = lower.findIndex((h) => h.includes('roll'))
  const secCol = lower.findIndex((h) => h.includes('section'))
  const nameCol = lower.findIndex((h) => h.includes('student') || h.includes('name'))
  const students = classStudents(papers)
  const byAdm = new Map(students.map((r) => [r.admission_no.toLowerCase(), r]))
  const byName = new Map(students.map((r) => [r.full_name.trim().toLowerCase(), r]))
  const byRoll = new Map(students.filter((r) => r.roll_no != null && r.roll_no !== '')
    .map((r) => [`${String(r.roll_no).trim()}|${(r.section ?? '').trim().toLowerCase()}`, r]))

  for (const cells of lines.slice(1)) {
    const adm = (idCol >= 0 ? cells[idCol] : '')?.trim() ?? ''
    const nm = (nameCol >= 0 ? cells[nameCol] : '')?.trim() ?? ''
    if (!adm && !nm && !(rollCol >= 0 && cells[rollCol]?.trim())) continue
    const roll = (rollCol >= 0 ? cells[rollCol] : '')?.trim() ?? ''
    const sec = (secCol >= 0 ? cells[secCol] : '')?.trim().toLowerCase() ?? ''
    const s = (adm ? byAdm.get(adm.toLowerCase()) : undefined)
      ?? (roll ? byRoll.get(`${roll}|${sec}`) : undefined) ?? byName.get(nm.toLowerCase())
    if (!s) { res.missed.push(adm || nm); continue }
    const who = `${s.full_name} (${s.admission_no})`
    let any = false
    // Per paper, so one bad part refuses that subject for the child, not the row.
    for (const p of papers) {
      if (!p.rows.some((r) => r.student_id === s.student_id)) continue
      const mine: Record<string, string> = {}
      let ok = true
      for (const c of cols) {
        if (c.paper !== p || !at.has(c)) continue
        const v = (cells[at.get(c)!] ?? '').trim()
        if (v === '') continue
        if (isAbsentCell(v)) { mine[c.key] = ABSENT; continue }
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) { res.errors.push(`${who}: ${c.heading.replace(/ \(.*\)$/, '')} "${v}" is not a mark`); ok = false; continue }
        if (n > c.max) { res.errors.push(`${who}: ${c.heading.replace(/ \(.*\)$/, '')} ${v} is more than ${c.max}`); ok = false; continue }
        mine[c.key] = v
      }
      if (!ok || !Object.keys(mine).length) continue
      // Unchanged from what is recorded: nothing to load, so a re-upload is a no-op.
      if (Object.entries(mine).every(([k, v]) => recordedCell(p, s.student_id, k) === v)) continue
      ;(res.cells[p.id] ??= {})[s.student_id] = mine
      any = true
    }
    if (any) res.filled++
  }
  return res
}

/** The save body for one paper from the cells typed for it, through the same
    routes the per-paper screen uses. */
export function paperSave(p: ClassPaper, cells: Record<string, Record<string, string>>):
  | { kind: 'parts'; body: { entries: { student_id: string; is_absent: boolean; parts: Record<string, number | null> }[] } }
  | { kind: 'marks'; body: { exam_subject_id: string; entries: { student_id: string; marks_obtained: number | null; is_absent: boolean }[] } } {
  const sids = Object.keys(cells)
  if (p.parts.length) {
    return { kind: 'parts', body: { entries: sids.map((sid) => {
      const c = cells[sid]
      const absent = Object.values(c).some((v) => v === ABSENT)
      return { student_id: sid, is_absent: absent, parts: absent ? {} : Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])) }
    }) } }
  }
  return { kind: 'marks', body: { exam_subject_id: p.id, entries: sids.map((sid) => {
    const v = cells[sid][ONE] ?? ''
    if (v === ABSENT) return { student_id: sid, marks_obtained: null, is_absent: true }
    return { student_id: sid, marks_obtained: v.trim() === '' ? null : Number(v), is_absent: false }
  }) } }
}

/** A grade from the scale's bands, as the server picks it. */
export function gradeFor(bands: { grade: string; min: number; max: number }[], got: number, outOf: number): string | null {
  if (!bands.length || !outOf) return null
  const pct = (got / outOf) * 100
  return bands.find((b) => pct >= b.min && pct <= b.max)?.grade ?? null
}

/** A typed value above the box's maximum (or below zero) is refused as it is typed
    (owner, 2026-10-13: 44 went into a box out of 25). "AB" and blanks pass. */
export function overMax(v: string, max: number | null | undefined): boolean {
  const t = v.trim()
  if (t === '' || /^ab$/i.test(t) || !/^-?\d*\.?\d*$/.test(t)) return false
  const n = Number(t)
  return Number.isFinite(n) && (n < 0 || (max != null && max > 0 && n > max))
}
