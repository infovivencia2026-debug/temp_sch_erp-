import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { coded } from '../exams/common'
import { type Boundary, boundaryLabel, csvResponse, pgArray, rollupBoundary, s, wantsCSV } from './common'
import { school } from '../school'

/* Port of report_builder.go (mountReportBuilder): the custom report builder.
   The client sends KEYS; the subjects below are the only place that knows a
   table or column, every value is a bound parameter, and every run carries
   the CALLER's scope, never the author's. */

const READ = 'admin.reports.read', SETTINGS = 'institution.settings.write'

interface Dimension { key: string; label: string; kind: string; expr: string }
interface Measure { key: string; label: string; kind: string; expr: string }
interface Field { key: string; label: string; kind: string; ops: string[]; options?: string[]; expr: string }
interface Subject {
  key: string; name: string; summary: string; dimensions: Dimension[]; measures: Measure[]; fields: Field[]
  from: string; where: string; scopeExpr: string; scope: (b: Boundary) => string[] | null
}

const opsText = ['eq', 'ne', 'contains', 'in', 'is_null', 'is_not_null']
const opsEnum = ['eq', 'ne', 'in', 'is_null', 'is_not_null']
const opsNumber = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null']
const opsDate = ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null']
const opsUUID = ['eq', 'in']

/** null is unrestricted; an empty list is a boundary that is genuinely empty. */
const sectionScope = (b: Boundary) => (b.all ? null : b.sections)
const departmentScope = (b: Boundary) => (b.all ? null : b.depts)

/** concat_ws(' ', ...): NULL parts skipped. */
const cw = (...parts: string[]) => `SUBSTR(${parts.map((p) => `COALESCE(' ' || ${p}, '')`).join(' || ')}, 2)`
const TODAY = `date('now','+330 minutes')`

const d = (key: string, label: string, kind: string, expr: string): Dimension => ({ key, label, kind, expr })
const f = (key: string, label: string, kind: string, ops: string[], expr: string, options?: string[]): Field =>
  ({ key, label, kind, ops, ...(options ? { options } : {}), expr })

const subjects: Subject[] = [
  {
    key: 'students', name: 'Students', summary: 'One row per enrolled student, with their class and section.',
    from: `students st
       JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
       JOIN sections sec ON sec.id = en.section_id
       JOIN classes cl ON cl.id = en.class_id`,
    where: '', scopeExpr: 'en.section_id', scope: sectionScope,
    dimensions: [
      d('admission_no', 'Admission no', 'text', 'st.admission_no'),
      d('full_name', 'Name', 'text', cw('st.first_name', "NULLIF(st.middle_name,'')", 'st.last_name')),
      d('class', 'Class', 'text', 'cl.name'), d('section', 'Section', 'text', 'sec.name'), d('roll_no', 'Roll no', 'number', 'en.roll_no'),
      d('gender', 'Gender', 'text', 'st.gender'), d('category', 'Category', 'text', 'st.category'), d('status', 'Status', 'text', 'st.status'),
      d('date_of_birth', 'Date of birth', 'date', 'st.date_of_birth'), d('admission_date', 'Admitted on', 'date', 'st.admission_date'),
      d('mother_tongue', 'Mother tongue', 'text', 'st.mother_tongue'), d('medium', 'Medium', 'text', 'st.medium'), d('city', 'City', 'text', 'st.city'),
    ],
    measures: [
      d('student_count', 'Students', 'number', 'count(DISTINCT st.id)'),
      d('rte_count', 'RTE students', 'number', 'count(DISTINCT CASE WHEN st.is_rte THEN st.id END)'),
      d('cwsn_count', 'CWSN students', 'number', 'count(DISTINCT CASE WHEN st.is_cwsn THEN st.id END)'),
    ],
    fields: [
      f('class_id', 'Class', 'uuid', opsUUID, 'en.class_id'), f('section_id', 'Section', 'uuid', opsUUID, 'en.section_id'),
      f('status', 'Status', 'enum', opsEnum, 'st.status', ['active', 'inactive', 'withdrawn', 'transferred', 'graduated', 'alumni']),
      f('gender', 'Gender', 'enum', opsEnum, 'st.gender', ['male', 'female', 'other']),
      f('category', 'Category', 'enum', opsEnum, 'st.category', ['general', 'obc', 'sc', 'st', 'ews', 'other']),
      f('admission_date', 'Admitted on', 'date', opsDate, 'st.admission_date'),
      f('full_name', 'Name', 'text', opsText, cw('st.first_name', 'st.last_name')),
      f('is_rte', 'RTE', 'enum', opsEnum, "CASE st.is_rte WHEN 1 THEN 'true' WHEN 0 THEN 'false' END", ['true', 'false']),
    ],
  },
  {
    key: 'attendance', name: 'Attendance', summary: 'One row per student per day marked, with the class it was marked in.',
    from: `student_attendance at
       JOIN students st ON st.id = at.student_id
       JOIN sections sec ON sec.id = at.section_id
       JOIN classes cl ON cl.id = sec.class_id`,
    where: '', scopeExpr: 'at.section_id', scope: sectionScope,
    dimensions: [
      d('on_date', 'Date', 'date', 'at.on_date'), d('admission_no', 'Admission no', 'text', 'st.admission_no'),
      d('full_name', 'Name', 'text', cw('st.first_name', 'st.last_name')), d('class', 'Class', 'text', 'cl.name'),
      d('section', 'Section', 'text', 'sec.name'), d('status', 'Status', 'text', 'at.status'),
      d('minutes_late', 'Minutes late', 'number', 'at.minutes_late'), d('month', 'Month', 'text', 'SUBSTR(at.on_date,1,7)'),
    ],
    measures: [
      d('marked_count', 'Days marked', 'number', 'count(*)'),
      d('present_count', 'Present', 'number', "count(CASE WHEN at.status = 'present' THEN 1 END)"),
      d('absent_count', 'Absent', 'number', "count(CASE WHEN at.status = 'absent' THEN 1 END)"),
      d('present_pct', 'Present %', 'number', "round(100.0 * count(CASE WHEN at.status = 'present' THEN 1 END) / nullif(count(*),0), 1)"),
    ],
    fields: [
      f('on_date', 'Date', 'date', opsDate, 'at.on_date'), f('section_id', 'Section', 'uuid', opsUUID, 'at.section_id'),
      f('class_id', 'Class', 'uuid', opsUUID, 'sec.class_id'),
      f('status', 'Status', 'enum', opsEnum, 'at.status', ['present', 'absent', 'late', 'half_day', 'leave', 'holiday']),
      f('minutes_late', 'Minutes late', 'number', opsNumber, 'at.minutes_late'),
    ],
  },
  {
    key: 'fees', name: 'Fees', summary: 'One row per invoice, with what it was for and what is still owed.',
    from: `invoices inv
       JOIN students st ON st.id = inv.student_id
       LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
       LEFT JOIN sections sec ON sec.id = en.section_id
       LEFT JOIN classes cl ON cl.id = en.class_id`,
    where: '', scopeExpr: 'en.section_id', scope: sectionScope,
    dimensions: [
      d('invoice_no', 'Invoice no', 'text', 'inv.invoice_no'), d('admission_no', 'Admission no', 'text', 'st.admission_no'),
      d('full_name', 'Name', 'text', cw('st.first_name', 'st.last_name')), d('class', 'Class', 'text', 'cl.name'),
      d('section', 'Section', 'text', 'sec.name'), d('status', 'Status', 'text', 'inv.status'),
      d('issued_on', 'Issued on', 'date', 'inv.issued_on'), d('due_on', 'Due on', 'date', 'inv.due_on'),
      d('net_paise', 'Billed', 'money', 'inv.net_paise'), d('paid_paise', 'Paid', 'money', 'inv.paid_paise'),
      d('balance_paise', 'Balance', 'money', 'inv.net_paise - inv.paid_paise'),
      d('days_overdue', 'Days overdue', 'number', `MAX(0, COALESCE(CAST(julianday(${TODAY}) - julianday(inv.due_on) AS INTEGER), 0))`),
    ],
    measures: [
      d('invoice_count', 'Invoices', 'number', 'count(*)'), d('student_count', 'Students', 'number', 'count(DISTINCT st.id)'),
      d('billed_paise', 'Billed', 'money', 'sum(inv.net_paise)'), d('collected_paise', 'Collected', 'money', 'sum(inv.paid_paise)'),
      d('outstanding_paise', 'Outstanding', 'money', 'sum(inv.net_paise - inv.paid_paise)'),
    ],
    fields: [
      f('status', 'Status', 'enum', opsEnum, 'inv.status', ['unpaid', 'part_paid', 'paid', 'cancelled']),
      f('issued_on', 'Issued on', 'date', opsDate, 'inv.issued_on'), f('due_on', 'Due on', 'date', opsDate, 'inv.due_on'),
      f('class_id', 'Class', 'uuid', opsUUID, 'en.class_id'), f('section_id', 'Section', 'uuid', opsUUID, 'en.section_id'),
      f('balance_paise', 'Balance (paise)', 'number', opsNumber, '(inv.net_paise - inv.paid_paise)'),
      f('academic_year_id', 'Academic year', 'uuid', opsUUID, 'inv.academic_year_id'),
    ],
  },
  {
    key: 'staff', name: 'Staff', summary: 'One row per employee, with their department and designation.',
    from: `employees emp
       LEFT JOIN departments dep ON dep.id = emp.department_id
       LEFT JOIN designations des ON des.id = emp.designation_id`,
    where: '', scopeExpr: 'emp.department_id', scope: departmentScope,
    dimensions: [
      d('employee_code', 'Staff code', 'text', 'emp.employee_code'), d('full_name', 'Name', 'text', cw('emp.first_name', 'emp.last_name')),
      d('department', 'Department', 'text', 'dep.name'), d('designation', 'Designation', 'text', 'des.name'),
      d('employment_type', 'Employment type', 'text', 'emp.employment_type'), d('status', 'Status', 'text', 'emp.status'),
      d('gender', 'Gender', 'text', 'emp.gender'), d('joined_on', 'Joined on', 'date', 'emp.joined_on'),
      d('qualification', 'Qualification', 'text', 'emp.qualification'),
      d('experience_years', 'Experience (years)', 'number', 'CAST(emp.experience_years AS REAL)'),
      d('years_of_service', 'Years here', 'number', `round((julianday(${TODAY}) - julianday(emp.joined_on)) / 365.25, 1)`),
    ],
    measures: [
      d('staff_count', 'Staff', 'number', 'count(*)'),
      d('avg_experience', 'Average experience', 'number', 'round(avg(CAST(emp.experience_years AS REAL)), 1)'),
    ],
    fields: [
      f('department_id', 'Department', 'uuid', opsUUID, 'emp.department_id'),
      f('status', 'Status', 'enum', opsEnum, 'emp.status', ['active', 'on_leave', 'suspended', 'relieved']),
      f('employment_type', 'Employment type', 'text', opsText, 'emp.employment_type'),
      f('joined_on', 'Joined on', 'date', opsDate, 'emp.joined_on'),
      f('gender', 'Gender', 'enum', opsEnum, 'emp.gender', ['male', 'female', 'other']),
      f('full_name', 'Name', 'text', opsText, cw('emp.first_name', 'emp.last_name')),
    ],
  },
]

/** The subjects as the schema endpoint serialises them (no SQL). */
const publicSubjects = subjects.map((sb) => ({
  key: sb.key, name: sb.name, summary: sb.summary,
  dimensions: sb.dimensions.map(({ key, label, kind }) => ({ key, label, kind })),
  measures: sb.measures.map(({ key, label, kind }) => ({ key, label, kind })),
  fields: sb.fields.map(({ key, label, kind, ops, options }) => ({ key, label, kind, ops, ...(options ? { options } : {}) })),
}))

const DEFAULT_LIMIT = 500, MAX_LIMIT = 5000, PAGE_SIZE = 100
const q = (v: string) => JSON.stringify(v)
const bytes = (v: string) => new TextEncoder().encode(v).length

interface Filter { field: string; op: string; value?: string; value2?: string; values?: string[] }
interface Definition {
  id?: string; name: string; description: string; subject: string; columns: string[]; filters: Filter[]; group_by: string[]
  sort_column: string; sort_dir: string; row_limit: number
}

function definitionOf(raw: Record<string, unknown>): Definition {
  const filters = Array.isArray(raw.filters) ? (raw.filters as Record<string, unknown>[]).map((x) => ({
    field: s(x?.field), op: s(x?.op), value: s(x?.value), value2: s(x?.value2),
    values: Array.isArray(x?.values) ? (x.values as unknown[]).map(String) : undefined,
  })) : []
  return {
    id: s(raw.id), name: s(raw.name), description: s(raw.description), subject: s(raw.subject),
    columns: Array.isArray(raw.columns) ? (raw.columns as unknown[]).map(String) : [],
    filters, group_by: Array.isArray(raw.group_by) ? (raw.group_by as unknown[]).map(String) : [],
    sort_column: s(raw.sort_column), sort_dir: s(raw.sort_dir), row_limit: typeof raw.row_limit === 'number' ? Math.trunc(raw.row_limit) : 0,
  }
}

function checkValue(fld: Field, v: string): void {
  switch (fld.kind) {
    case 'number': if (v.trim() === '' || !Number.isFinite(Number(v))) throw new Error(`${fld.label}: ${q(v)} is not a number`); break
    case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw new Error(`${fld.label}: ${q(v)} is not a date (YYYY-MM-DD)`); break
    case 'uuid': if (!isUUID(v)) throw new Error(`${fld.label}: pick a value from the list`); break
    case 'enum': if (fld.options && fld.options.length && !fld.options.includes(v)) throw new Error(`${fld.label}: ${q(v)} is not one of the permitted values`); break
    case 'text': if (bytes(v) > 200) throw new Error(`${fld.label}: that is too long to search for`); break
  }
}

function validateFilter(sb: Subject, flt: Filter): void {
  const fld = sb.fields.find((x) => x.key === flt.field)
  if (!fld) throw new Error(`cannot filter on ${q(flt.field)}`)
  if (!fld.ops.includes(flt.op)) throw new Error(`${q(fld.label)} cannot be compared with ${q(flt.op)}`)
  flt.value = (flt.value ?? '').trim()
  flt.value2 = (flt.value2 ?? '').trim()
  switch (flt.op) {
    case 'is_null': case 'is_not_null':
      flt.value = ''; flt.value2 = ''; delete flt.values; return
    case 'in': {
      const clean: string[] = []
      for (const raw of flt.values ?? []) { const v = raw.trim(); if (v === '') continue; checkValue(fld, v); clean.push(v) }
      if (clean.length === 0) throw new Error(`${fld.label}: give at least one value to match`)
      if (clean.length > 200) throw new Error(`${fld.label}: too many values in one filter`)
      flt.values = clean; flt.value = ''; flt.value2 = ''; return
    }
    case 'between':
      if (flt.value === '' || flt.value2 === '') throw new Error(`${fld.label}: a range needs both ends`)
      checkValue(fld, flt.value); checkValue(fld, flt.value2); delete flt.values; return
    default:
      if (flt.value === '') throw new Error(`${fld.label}: give a value to compare against`)
      checkValue(fld, flt.value); delete flt.values
  }
}

/** validateReportDefinition: on save and before every run. Normalises the definition in place. */
function validate(def: Definition): Subject {
  def.name = def.name.trim()
  def.description = def.description.trim()
  if (def.name === '') throw new Error('give the report a name')
  if (bytes(def.name) > 120) throw new Error('that name is too long')
  const sb = subjects.find((x) => x.key === def.subject)
  if (!sb) throw new Error(`${q(def.subject)} is not a subject you can report on`)
  if (def.columns.length === 0) throw new Error('pick at least one column')
  if (def.columns.length > 20) throw new Error('a report with more than twenty columns is a spreadsheet export, not a report')
  const grouped = def.group_by.length > 0
  const inGroup = new Set<string>()
  for (const g of def.group_by) {
    if (!sb.dimensions.some((x) => x.key === g)) throw new Error(`cannot group by ${q(g)}`)
    if (inGroup.has(g)) throw new Error(`${q(g)} is grouped twice`)
    inGroup.add(g)
  }
  const seen = new Set<string>()
  for (const col of def.columns) {
    if (seen.has(col)) throw new Error(`${q(col)} is selected twice`)
    seen.add(col)
    const isDim = sb.dimensions.some((x) => x.key === col), isMeasure = sb.measures.some((x) => x.key === col)
    if (!isDim && !isMeasure) throw new Error(`${q(col)} is not a column of ${sb.name}`)
    if (!grouped && isMeasure) throw new Error(`${q(col)} is a total. Group the report by something before you can show it`)
    if (grouped && isDim && !inGroup.has(col)) throw new Error(`${q(col)} is not grouped, so there is no single value for it. Group by it or drop it`)
  }
  for (const g of def.group_by) if (!seen.has(g)) throw new Error(`${q(g)} is grouped but not shown. The rows would be unreadable`)
  for (const flt of def.filters) validateFilter(sb, flt)
  if (def.sort_column !== '' && !seen.has(def.sort_column)) throw new Error(`cannot sort by ${q(def.sort_column)}. It is not one of the shown columns`)
  if (def.sort_dir === '') def.sort_dir = 'asc'
  else if (def.sort_dir !== 'asc' && def.sort_dir !== 'desc') throw new Error('sort direction must be asc or desc')
  if (def.row_limit === 0) def.row_limit = DEFAULT_LIMIT
  if (def.row_limit < 1 || def.row_limit > MAX_LIMIT) throw new Error(`the row cap must be between 1 and ${MAX_LIMIT}`)
  return sb
}

const convert = (fld: Field, v: string): unknown => (fld.kind === 'number' ? Number(v) : v)

function filterSQL(sb: Subject, flt: Filter, args: unknown[]): string {
  const fld = sb.fields.find((x) => x.key === flt.field)
  if (!fld) throw new Error(`${q(flt.field)} is no longer a filter on this subject`)
  switch (flt.op) {
    case 'is_null': return `(${fld.expr}) IS NULL`
    case 'is_not_null': return `(${fld.expr}) IS NOT NULL`
    case 'contains': args.push(flt.value); return `(${fld.expr}) LIKE '%' || ? || '%'`
    case 'in': args.push(JSON.stringify((flt.values ?? []).map((v) => convert(fld, v)))); return `(${fld.expr}) IN (SELECT value FROM json_each(?))`
    case 'between': args.push(convert(fld, flt.value ?? ''), convert(fld, flt.value2 ?? '')); return `(${fld.expr}) BETWEEN ? AND ?`
  }
  const op = ({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[flt.op]
  if (!op) throw new Error(`unsupported comparison ${q(flt.op)}`)
  args.push(convert(fld, flt.value ?? ''))
  return `(${fld.expr}) ${op} ?`
}

/** buildReportSQL: one parameterised statement, its count, and the column labels. */
function buildSQL(sb: Subject, def: Definition, scopeIDs: string[] | null, limit: number, offset: number) {
  const selects: string[] = [], labels: string[] = []
  for (const key of def.columns) {
    const dim = sb.dimensions.find((x) => x.key === key) ?? sb.measures.find((x) => x.key === key)
    if (!dim) throw new Error(`${q(key)} is no longer available on this subject`)
    selects.push(dim.expr)
    labels.push(dim.label)
  }
  const args: unknown[] = []
  const where: string[] = []
  if (sb.where) where.push(sb.where)
  const scope = scopeIDs === null ? null : JSON.stringify(scopeIDs)
  args.push(scope, scope)
  where.push(`(? IS NULL OR ${sb.scopeExpr} IN (SELECT value FROM json_each(?)))`)
  for (const flt of def.filters) where.push(filterSQL(sb, flt, args))
  let sql = `SELECT ${selects.join(', ')}\n  FROM ${sb.from}\n WHERE ${where.join('\n   AND ')}`
  let count = `SELECT count(*) AS n FROM (SELECT 1 FROM ${sb.from} WHERE ${where.join(' AND ')}`
  if (def.group_by.length) {
    const exprs = def.group_by.map((g) => {
      const dim = sb.dimensions.find((x) => x.key === g)
      if (!dim) throw new Error(`${q(g)} is no longer groupable`)
      return dim.expr
    })
    sql += `\n GROUP BY ${exprs.join(', ')}`
    count += ` GROUP BY ${exprs.join(', ')}`
  }
  count += ')'
  if (def.sort_column !== '') {
    const i = def.columns.indexOf(def.sort_column)
    if (i >= 0) sql += `\n ORDER BY ${i + 1} ${def.sort_dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
  }
  if (limit > def.row_limit) limit = def.row_limit
  if (offset >= def.row_limit) limit = 0
  else if (offset + limit > def.row_limit) limit = def.row_limit - offset
  sql += `\n LIMIT ? OFFSET ?`
  return { sql, count, args, pageArgs: [limit, offset], labels, limit }
}

function slug(name: string): string {
  let out = ''
  for (const ch of name.trim().toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch
    else if (out.length > 0) out += '-'
  }
  out = out.replace(/^-+|-+$/g, '')
  return out === '' ? 'report' : out
}

const cell = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

const visibility = `(d.created_by = ?1 OR ?2 OR EXISTS (SELECT 1 FROM report_shares sh JOIN roles ro ON ro.key = sh.role_key
    JOIN user_roles ur ON ur.role_id = ro.id AND ur.user_id = ?1 WHERE sh.report_id = d.id))`
const definitionSelect = `
  SELECT d.id, d.name, d.description, d.subject, d.columns, d.filters, d.group_by, d.sort_column, d.sort_dir, d.row_limit, d.created_by,
         d.created_by = ?1 AS mine, SUBSTR(d.updated_at,1,16) AS updated_at,
         (SELECT json_group_array(role_key) FROM (SELECT role_key FROM report_shares sh WHERE sh.report_id = d.id ORDER BY role_key)) AS shared_with
    FROM report_definitions d`

function definitionRow(c: Ctx, v: Record<string, unknown>) {
  let filters: Filter[] = []
  try { const x = JSON.parse(String(v.filters ?? '')); if (Array.isArray(x)) filters = x } catch { /* shown with none */ }
  const mine = v.mine === 1
  const out: Record<string, unknown> = { id: v.id, name: v.name }
  if (v.description !== null) out.description = v.description
  out.subject = v.subject
  out.subject_name = subjects.find((x) => x.key === v.subject)?.name ?? ''
  out.columns = pgArray(v.columns)
  out.filters = filters
  out.group_by = pgArray(v.group_by)
  if (v.sort_column !== null) out.sort_column = v.sort_column
  out.sort_dir = v.sort_dir
  out.row_limit = Number(v.row_limit)
  if (v.created_by !== null) out.created_by = v.created_by
  out.created_by_me = mine
  out.can_edit = mine || can(c.id, SETTINGS)
  out.shared_with = pgArray(v.shared_with)
  out.updated_at = v.updated_at
  return out
}

async function loadDefinition(c: Ctx, id: string): Promise<Record<string, unknown>> {
  const b = await rollupBoundary(c)
  const row = await c.db.prepare(definitionSelect + ` WHERE d.id = ?3 AND ${visibility}`).bind(c.id.userId, b.all ? 1 : 0, id).first<Record<string, unknown>>()
  if (!row) throw notFound('resource not found')
  return definitionRow(c, row)
}

const reportID = (c: Ctx) => { if (!isUUID(c.params.id)) throw notFound('resource not found'); return c.params.id }
const bad = (e: unknown): never => { if (e instanceof HttpError) throw e; throw badRequest(e instanceof Error ? e.message : String(e)) }

async function execute(c: Ctx, def: Definition, saved: string | null): Promise<Response> {
  let sb: Subject
  try { sb = validate(def) } catch (e) { bad(e) }
  const b = await rollupBoundary(c)
  const csv = wantsCSV(c)
  const qp = c.url.searchParams
  let limit = PAGE_SIZE, offset = 0
  const lv = Number(qp.get('limit')), ov = Number(qp.get('offset'))
  if (/^[+-]?\d+$/.test(qp.get('limit') ?? '') && lv > 0) limit = lv
  if (/^[+-]?\d+$/.test(qp.get('offset') ?? '') && ov > 0) offset = ov
  if (limit > PAGE_SIZE) limit = PAGE_SIZE
  if (csv) { limit = def.row_limit; offset = 0 }
  let built: ReturnType<typeof buildSQL>
  try { built = buildSQL(sb!, def, sb!.scope(b), limit, offset) } catch (e) { bad(e) }
  const started = Date.now()
  const cnt = await c.db.prepare(built!.count).bind(...built!.args).first<{ n: number }>()
  const total = Number(cnt?.n ?? 0)
  // raw(): positional rows, so two columns with the same expression stay two cells.
  const raw = await c.db.prepare(built!.sql).bind(...built!.args, ...built!.pageArgs).raw<unknown[]>()
  const rows = raw.map((r0) => r0.map(cell))
  const columns = def.columns.map((key, i) => {
    const kind = sb!.dimensions.find((x) => x.key === key)?.kind ?? sb!.measures.find((x) => x.key === key)?.kind ?? 'text'
    return { key, label: built!.labels[i], kind }
  })
  const took = Date.now() - started
  if (saved) {
    try {
      await c.db.prepare(`INSERT INTO report_runs (id, institution_id, report_id, ran_by, ran_at, row_count, exported, scope_label, duration_ms)
          VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), school(c).id, saved, c.id.userId, now(), rows.length, csv ? 1 : 0, boundaryLabel(b), took).run()
    } catch (e) { console.error('report run not recorded', e) }
  }
  if (csv) return csvResponse(slug(def.name), columns.map((x) => x.label), rows.map((r0) => columns.map((_, i) => r0[i] ?? '')))
  const lim = built!.limit
  return ok({
    columns, rows, total, limit: lim, offset,
    has_more: offset + rows.length < total && offset + rows.length < def.row_limit,
    row_limit: def.row_limit, truncated: total > def.row_limit, scope: boundaryLabel(b), grouped: def.group_by.length > 0,
    took_ms: Date.now() - started,
  })
}

export function registerReportBuilder(r: Router) {
  r.get('/report-builder/schema', READ, async (c) => {
    const b = await rollupBoundary(c)
    const roles = await c.db.prepare(`SELECT key, name FROM roles WHERE institution_id = ? OR institution_id IS NULL ORDER BY name`)
      .bind(school(c).id).all<{ key: string; name: string }>()
    return ok({ subjects: publicSubjects, roles: roles.results, scope: boundaryLabel(b), max_row_limit: MAX_LIMIT, page_size: PAGE_SIZE })
  })

  r.get('/report-builder/definitions', READ, async (c) => {
    const b = await rollupBoundary(c)
    const rows = await c.db.prepare(definitionSelect + ` WHERE ${visibility} ORDER BY d.name`).bind(c.id.userId, b.all ? 1 : 0).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => definitionRow(c, v)) })
  })

  r.post('/report-builder/definitions', READ, async (c) => {
    const def = definitionOf(await readJSON(c.req))
    try { validate(def) } catch (e) { bad(e) }
    const inst = school(c).id, t = now()
    const cols = JSON.stringify(def.columns), groups = JSON.stringify(def.group_by), filters = JSON.stringify(def.filters.map((x) => {
      const o: Record<string, unknown> = { field: x.field, op: x.op }
      if (x.value) o.value = x.value
      if (x.value2) o.value2 = x.value2
      if (x.values && x.values.length) o.values = x.values
      return o
    }))
    const id = (def.id ?? '').trim()
    // report_definitions_name_unique (institution, lower(btrim(name))), which D1 does not carry.
    const dupe = await c.db.prepare(`SELECT 1 FROM report_definitions WHERE institution_id = ? AND lower(TRIM(name)) = lower(?) AND id <> ?`)
      .bind(inst, def.name, id).first()
    if (dupe) throw coded(409, 'duplicate_name', 'a report of that name already exists. Two reports with one name is how a school stops trusting both')
    if (id === '') {
      const out = uuid()
      await c.db.prepare(`INSERT INTO report_definitions (id, institution_id, name, description, subject, columns, filters, group_by, sort_column, sort_dir,
          row_limit, created_by, created_at, updated_at) VALUES (?,?,?,NULLIF(?,''),?,?,?,?,NULLIF(?,''),?,?,?,?,?)`)
        .bind(out, inst, def.name, def.description, def.subject, cols, filters, groups, def.sort_column, def.sort_dir, def.row_limit, c.id.userId, t, t).run()
      return ok({ id: out })
    }
    if (!isUUID(id)) throw badRequest('id must be a uuid')
    const res = await c.db.prepare(`UPDATE report_definitions SET name = ?, description = NULLIF(?,''), subject = ?, columns = ?, filters = ?, group_by = ?,
        sort_column = NULLIF(?,''), sort_dir = ?, row_limit = ?, updated_at = ? WHERE id = ? AND (created_by = ? OR ?)`)
      .bind(def.name, def.description, def.subject, cols, filters, groups, def.sort_column, def.sort_dir, def.row_limit, t, id, c.id.userId,
        can(c.id, SETTINGS) ? 1 : 0).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ id })
  })

  r.post('/report-builder/preview', READ, async (c) => {
    const def = definitionOf(await readJSON(c.req))
    if (def.name.trim() === '') def.name = 'Preview'
    return execute(c, def, null)
  })

  r.get('/report-builder/definitions/{id}', READ, async (c) => ok(await loadDefinition(c, reportID(c))))

  r.del('/report-builder/definitions/{id}', READ, async (c) => {
    const id = reportID(c)
    const res = await c.db.prepare(`DELETE FROM report_definitions WHERE id = ? AND (created_by = ? OR ?)`).bind(id, c.id.userId, can(c.id, SETTINGS) ? 1 : 0).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ deleted: true })
  })

  r.get('/report-builder/definitions/{id}/run', READ, async (c) => {
    const id = reportID(c)
    const def = await loadDefinition(c, id)
    return execute(c, {
      name: String(def.name), description: '', subject: String(def.subject), columns: def.columns as string[], filters: def.filters as Filter[],
      group_by: def.group_by as string[], sort_column: typeof def.sort_column === 'string' ? def.sort_column : '', sort_dir: String(def.sort_dir),
      row_limit: Number(def.row_limit),
    }, id)
  })

  r.post('/report-builder/definitions/{id}/shares', READ, async (c) => {
    const id = reportID(c)
    const req = await readJSON(c.req)
    const role = s(req.role_key).trim()
    if (role === '') throw badRequest('pick a role to share with')
    const owned = await c.db.prepare(`SELECT (created_by = ? OR ?) AS owned FROM report_definitions WHERE id = ?`)
      .bind(c.id.userId, can(c.id, SETTINGS) ? 1 : 0, id).first<{ owned: number | null }>()
    if (!owned || owned.owned !== 1) throw notFound('resource not found')
    const exists = await c.db.prepare(`SELECT 1 FROM roles WHERE key = ? AND (institution_id = ? OR institution_id IS NULL)`).bind(role, school(c).id).first()
    if (!exists) throw badRequest('no such role')
    await c.db.prepare(`INSERT OR IGNORE INTO report_shares (report_id, role_key, shared_at, shared_by) VALUES (?,?,?,?)`).bind(id, role, now(), c.id.userId).run()
    return ok({ shared: true })
  })

  r.del('/report-builder/definitions/{id}/shares/{role}', READ, async (c) => {
    const id = reportID(c)
    const role = (c.params.role ?? '').trim()
    if (role === '') throw badRequest('which role?')
    const res = await c.db.prepare(`DELETE FROM report_shares WHERE report_id = ?1 AND role_key = ?2
        AND EXISTS (SELECT 1 FROM report_definitions d WHERE d.id = ?1 AND (d.created_by = ?3 OR ?4))`)
      .bind(id, role, c.id.userId, can(c.id, SETTINGS) ? 1 : 0).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ unshared: true })
  })

  r.get('/report-builder/definitions/{id}/runs', READ, async (c) => {
    const id = reportID(c)
    await loadDefinition(c, id)
    const rows = await c.db.prepare(`SELECT run.id, SUBSTR(run.ran_at,1,16) AS ran_at, u.full_name AS ran_by, run.row_count, run.exported, run.scope_label,
        run.duration_ms FROM report_runs run LEFT JOIN users u ON u.id = run.ran_by WHERE run.report_id = ? ORDER BY run.ran_at DESC LIMIT 100`)
      .bind(id).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, ran_at: v.ran_at }
      if (v.ran_by !== null) o.ran_by = v.ran_by
      o.row_count = Number(v.row_count); o.exported = v.exported === 1; o.scope = v.scope_label
      if (v.duration_ms !== null) o.took_ms = Number(v.duration_ms)
      return o
    }) })
  })
}
