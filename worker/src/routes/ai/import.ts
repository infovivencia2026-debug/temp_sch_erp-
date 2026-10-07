import type { Ctx, Router } from '../../router'
import { badRequest, HttpError, ok, readJSON } from '../../http'
import { can } from '../../identity'
import { importSpecs } from '../setup/imports'
import { parseCSV } from '../setup/imports'
import { assistantFailure, assistantRateLimit } from '../teaching/gemini'
import { dispatch } from '../misc/assistant/actions'
import { geminiKeySet, llmFromEnv } from '../../services/ai/gemini_seam'
import { isZip, readXLSX } from '../../services/ai/xlsx_read'
import {
  extractTableFromImage, gridToTable, normaliseRows, proposeImport, toImporterCSV,
  type ColumnMap, type ImportKind, type SchoolClass, type Table,
} from '../../services/ai/smart_import'

/* "Import with AI": any spreadsheet (CSV or .xlsx) or a photo of a paper
   register goes in; the AI proposes the import kind and the column mapping;
   the person adjusts and previews; commit goes through the very route the
   setup screen uses (dispatch as the caller), so the importer's validation,
   permissions, undoable import run and history all apply unchanged.

   POST /ai/import/analyze  multipart file (+ kind)     -> table + proposal (photo: table to review)
   POST /ai/import/propose  {table, kind?}              -> proposal (after editing a photo's table)
   POST /ai/import/preview  {kind, table, mapping, source, reviewed} -> dry run with per-row problems
   POST /ai/import/commit   same, confirmed: true      -> the real import */

/** What the smart importer may prepare. Pay, payslips, exits and device punches stay on their own screens. */
const KIND_LABEL: Record<string, string> = {
  students: 'Students', classes: 'Classes and sections', sections: 'Sections', subjects: 'Subjects', periods: 'Periods',
  holidays: 'Holidays and calendar', timetable: 'Timetable', class_subjects: 'Class subjects', allocations: 'Teacher allocations',
  attendance: 'Student attendance', staff_attendance: 'Staff attendance', marks: 'Marks', student_history: 'Student history',
  staff: 'Staff', staff_history: 'Staff history', fee_heads: 'Fee heads', fee_structures: 'Fee structures', fee_payments: 'Fee payments',
}
const STUDENT_COLUMNS = ['full_name', 'admission_no', 'date_of_birth', 'gender', 'blood_group', 'medium', 'mother_tongue', 'class', 'section', 'roll_no',
  'address', 'city', 'state', 'pincode', 'prior_school', 'admission_date', 'previous_class', 'previous_year', 'father_name', 'father_phone',
  'father_email', 'mother_name', 'mother_phone', 'mother_email', 'guardian_name', 'guardian_relation', 'guardian_phone', 'guardian_email']

const MAX_ROWS = 5000
const MAX_BYTES = 8 << 20
const IMAGE = /^image\/(jpeg|png|webp|heic|heif)$/

function kindsFor(c: Ctx): ImportKind[] {
  const out: ImportKind[] = []
  for (const [key, label] of Object.entries(KIND_LABEL)) {
    if (key === 'students') { if (can(c.id, 'students.write')) out.push({ key, label, columns: STUDENT_COLUMNS, required: ['full_name'] }); continue }
    const s = importSpecs[key]
    if (s && can(c.id, s.perm)) out.push({ key, label, columns: s.columns, required: s.required })
  }
  return out
}

function needSchool(c: Ctx) {
  if (!c.id.institution) throw new HttpError(400, 'this needs a school in scope', { code: 'no_institution' })
}

function cleanTable(t: unknown): Table {
  const x = t as Table
  if (!x || !Array.isArray(x.headers) || !Array.isArray(x.rows)) throw badRequest('send the table as {headers: [...], rows: [[...]]}')
  const headers = x.headers.map((h) => String(h ?? '').slice(0, 200))
  if (headers.length === 0 || headers.length > 200) throw badRequest('the table needs between 1 and 200 columns')
  if (x.rows.length > MAX_ROWS) throw badRequest(`at most ${MAX_ROWS} rows at a time; split the file`)
  return { headers, rows: x.rows.map((r) => headers.map((_, i) => String((Array.isArray(r) ? r[i] : '') ?? '').slice(0, 2000))) }
}

const noAI = () => new HttpError(503, 'Reading photos needs the AI, which is not set up on this server. Type the register into a spreadsheet and upload that instead.', { code: 'ai_not_configured' })

async function schoolClasses(c: Ctx): Promise<SchoolClass[]> {
  const r = await c.db.prepare(`SELECT name, level FROM classes ORDER BY level`).all<{ name: string; level: number | null }>()
  return (r.results ?? []).map((x) => ({ name: x.name, level: x.level === null ? null : Number(x.level) }))
}

async function analyze(c: Ctx): Promise<Response> {
  needSchool(c)
  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('send the file as multipart form data in `file`')
  const file = form.get('file')
  if (!file || typeof file === 'string') throw badRequest('attach a spreadsheet or a photo in `file`')
  const f = file as unknown as File
  const bytes = new Uint8Array(await f.arrayBuffer())
  if (bytes.byteLength === 0) throw badRequest('that file was empty')
  if (bytes.byteLength > MAX_BYTES) throw badRequest('that file is larger than 8 MB')
  const kinds = kindsFor(c)
  if (kinds.length === 0) throw new HttpError(403, 'you do not have permission to import anything', { code: 'forbidden' })
  const forced = String(form.get('kind') ?? '').trim() || undefined
  if (forced && !kinds.some((k) => k.key === forced)) throw new HttpError(403, 'you cannot import ' + forced, { code: 'forbidden' })
  const name = f.name ?? ''
  const mime = (f.type || '').toLowerCase()
  const llm = await llmFromEnv(c.env, 55_000)

  if (IMAGE.test(mime) || /\.(jpe?g|png|webp|heic)$/i.test(name)) {
    if (!llm) throw noAI()
    await assistantRateLimit(c)
    let b64 = ''
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    try {
      const t = await extractTableFromImage(llm, btoa(b64), IMAGE.test(mime) ? mime : 'image/jpeg')
      // Photos stop here: the person checks every cell, then asks for a proposal.
      return ok({ source: 'photo', filename: name, table: { headers: t.headers, rows: t.rows.slice(0, MAX_ROWS) }, uncertain: t.uncertain, notes: t.notes,
        needs_review: true, kinds, ai: true })
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('could not read a table')) throw badRequest('No table could be read from that photo. Try a sharper, straight-on photo in good light.')
      throw assistantFailure(e)
    }
  }

  let grid: string[][]
  if (isZip(bytes)) {
    try { grid = (await readXLSX(bytes)).rows } catch (e) { throw badRequest('that workbook could not be read: ' + (e as Error).message + '. Save it as .xlsx or CSV and try again.') }
  } else if (/\.xls$/i.test(name)) {
    throw badRequest('old .xls files cannot be read; save it as .xlsx or CSV and try again')
  } else {
    const text = new TextDecoder('utf-8').decode(bytes)
    const tab = !text.includes(',') && text.includes('\t')
    grid = tab ? text.split(/\r?\n/).map((l) => l.split('\t')) : parseCSV(text).rows
  }
  const table = gridToTable(grid)
  if (table.headers.length === 0) throw badRequest('no table was found in that file')
  if (table.rows.length > MAX_ROWS) throw badRequest(`that sheet has ${table.rows.length} rows; at most ${MAX_ROWS} at a time`)
  if (llm) await assistantRateLimit(c)
  const proposal = await proposeImport(llm, table, kinds, forced)
  return ok({ source: 'sheet', filename: name, table, proposal, kinds, ai: !!llm })
}

async function propose(c: Ctx): Promise<Response> {
  needSchool(c)
  const body = await readJSON<{ table?: unknown; kind?: string }>(c.req)
  const table = cleanTable(body.table)
  const kinds = kindsFor(c)
  const forced = body.kind && kinds.some((k) => k.key === body.kind) ? body.kind : undefined
  const llm = await llmFromEnv(c.env, 40_000)
  if (llm) await assistantRateLimit(c)
  return ok({ proposal: await proposeImport(llm, table, kinds, forced), kinds, ai: !!llm })
}

interface RunBody { kind?: string; table?: unknown; mapping?: { index?: number; field?: string | null }[]; source?: string; reviewed?: boolean; confirmed?: boolean; filename?: string }

async function run(c: Ctx, commit: boolean): Promise<Response> {
  needSchool(c)
  const body = await readJSON<RunBody>(c.req)
  const kind = kindsFor(c).find((k) => k.key === body.kind)
  if (!kind) throw new HttpError(403, 'you cannot import ' + (body.kind || 'that'), { code: 'forbidden' })
  const table = cleanTable(body.table)
  if (body.source === 'photo' && !body.reviewed) throw badRequest('check the table read from the photo, then tick "I have checked every row" before previewing')
  if (commit && !body.confirmed) throw badRequest('confirm the import first')
  const used = new Set<string>()
  const mapping: ColumnMap[] = table.headers.map((header, index) => {
    const m = (body.mapping ?? []).find((x) => x.index === index)
    const field = m?.field && kind.columns.includes(m.field) && !used.has(m.field) ? m.field : null
    if (field) used.add(field)
    return { header, index, field, confidence: 1, source: 'user' }
  })
  const missing = kind.required.filter((r) => !used.has(r) && !(r === 'section' && used.has('class')))
  if (missing.length) throw badRequest(`map a column to ${missing.join(', ')} (required for ${kind.label})`, { missing })

  const { rows, changes, sourceRows } = normaliseRows(kind, table, mapping, await schoolClasses(c))
  const csv = toImporterCSV(kind, rows)
  const qs = new URLSearchParams({ commit: String(commit), filename: (body.filename || 'ai-import').slice(0, 200) + (body.source === 'photo' ? ' (photo, reviewed)' : '') })
  const path = kind.key === 'students' ? `/students/import?${qs}` : `/setup/import/${kind.key}?${qs}`
  const r = await dispatch(c, 'POST', path, new TextEncoder().encode(csv), 'text/csv')
  const err = typeof r.data.error === 'string' ? r.data.error : (r.data.error as { message?: string } | undefined)?.message
  if (r.status !== 200) throw new HttpError(r.status === 403 ? 403 : 400, err || 'the importer refused that file')
  const problems = (Array.isArray(r.data.problems) ? r.data.problems : []) as { row: number; problem?: string; data?: Record<string, string> }[]
  return ok({
    kind: kind.key, label: kind.label, dry_run: !commit,
    total: Number(r.data.total ?? 0), valid: Number(r.data.valid ?? 0), rejected: Number(r.data.rejected ?? 0), imported: Number(r.data.imported ?? 0),
    run_id: r.data.run_id ?? null,
    // Importer rows are CSV lines (header = 1); point each problem back at the table row the person sees.
    problems: problems.slice(0, 500).map((p) => ({ ...p, source_row: sourceRows[p.row - 2] ?? null })),
    rows: commit ? undefined : rows.slice(0, 1000),
    source_rows: commit ? undefined : sourceRows.slice(0, 1000),
    fields: kind.columns.filter((f) => rows.some((x) => x[f] !== undefined)),
    changes: commit ? undefined : changes.slice(0, 500),
  })
}

export function registerAIImport(r: Router): void {
  r.get('/ai/import/kinds', 'auth', async (c) => ok({ kinds: kindsFor(c), ai: (await geminiKeySet(c.env)) }))
  r.post('/ai/import/analyze', 'auth', analyze)
  r.post('/ai/import/propose', 'auth', propose)
  r.post('/ai/import/preview', 'auth', (c) => run(c, false))
  r.post('/ai/import/commit', 'auth', (c) => run(c, true))
}
